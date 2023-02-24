const dogecore = require('bitcore-lib-doge')
const axios = require('axios')
const fs = require('fs')
const dotenv = require('dotenv')
const mime = require('mime-types')
const { PrivateKey, Address, Transaction, Script } = dogecore
const { Hash, Signature } = dogecore.crypto

dotenv.config()

if (process.env.TESTNET == 'true') {
    dogecore.Networks.defaultNetwork = dogecore.Networks.testnet
}

if (process.env.FEE_PER_KB) {
    Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB)
} else {
    Transaction.FEE_PER_KB = 100000000
}


async function main() {
    let cmd = process.argv[2]

    if (cmd == 'mint') {
        await mint()
    } else if (cmd == 'wallet') {
        await wallet()
    } else {
        throw new Error('unknown command')
    }
}


async function wallet() {
    let subcmd = process.argv[3]

    if (subcmd == 'new') {
        walletNew()
    } else if (subcmd == 'sync') {
        await walletSync()
    } else if (subcmd == 'balance') {
        walletBalance()
    } else if (subcmd == 'send') {
        await walletSend()
    } else if (subcmd == 'split') {
        await walletSplit()
    } else {
        throw new Error('unknown subcommand')
    }
}


function walletNew() {
    if (!fs.existsSync('.wallet.json')) {
        const privateKey = new PrivateKey()
        const privkey = privateKey.toWIF()
        const address = privateKey.toAddress().toString()
        const json = { privkey, address, utxos: [] }
        fs.writeFileSync('.wallet.json', JSON.stringify(json, 0, 2))
        console.log('address', address)
    } else {
        throw new Error('wallet already exists')
    }
}


async function walletSync() {
    if (process.env.TESTNET == 'true') throw new Error('no testnet api')

    let wallet = JSON.parse(fs.readFileSync('.wallet.json'))

    console.log('syncing utxos with dogechain.info api')

    let response = await axios.get(`https://dogechain.info/api/v1/address/unspent/${wallet.address}`)
    wallet.utxos = response.data.unspent_outputs.map(output => {
        return {
            txid: output.tx_hash,
            vout: output.tx_output_n,
            script: output.script,
            satoshis: output.value
        }
    })

    fs.writeFileSync('.wallet.json', JSON.stringify(wallet, 0, 2))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)

    console.log('balance', balance)
}


function walletBalance() {
    let wallet = JSON.parse(fs.readFileSync('.wallet.json'))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)

    console.log(wallet.address, balance)
}


async function walletSend() {
    const argAddress = process.argv[4]
    const argAmount = process.argv[5]

    let wallet = JSON.parse(fs.readFileSync('.wallet.json'))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    if (balance == 0) throw new Error('no funds to send')

    let receiver = new Address(argAddress)
    let amount = parseInt(argAmount)

    let tx = new Transaction()
    if (amount) {
        tx.to(receiver, amount)
        fund(wallet, tx)
    } else {
        tx.from(wallet.utxos)
        tx.change(receiver)
        tx.sign(wallet.privkey)
    }

    await broadcast(tx)

    console.log(tx.hash)
}


async function walletSplit() {
    let splits = parseInt(process.argv[4])

    let wallet = JSON.parse(fs.readFileSync('.wallet.json'))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    if (balance == 0) throw new Error('no funds to split')

    let tx = new Transaction()
    tx.from(wallet.utxos)
    for (let i = 0; i < splits - 1; i++) {
        tx.to(wallet.address, Math.floor(balance / splits))
    }
    tx.change(wallet.address)
    tx.sign(wallet.privkey)

    await broadcast(tx)

    console.log(tx.hash)
}


const MAX_SCRIPT_ELEMENT_SIZE = 520

async function mint() {
    const argAddress = process.argv[3]
    const argContentTypeOrFilename = process.argv[4]
    const argHexData = process.argv[5]

    let address = new Address(argAddress)
    let contentType
    let data

    if (fs.existsSync(argContentTypeOrFilename)) {
        contentType = mime.contentType(mime.lookup(argContentTypeOrFilename))
        data = fs.readFileSync(argContentTypeOrFilename)
    } else {
        contentType = argContentTypeOrFilename
        data = Buffer.from(argHexData, 'hex')
    }


    if (contentType.length > MAX_SCRIPT_ELEMENT_SIZE) {
        throw new Error('content type too long')
    }


    let wallet = JSON.parse(fs.readFileSync('.wallet.json'))

    if (data.length < MAX_SCRIPT_ELEMENT_SIZE) {
        txs = inscribeOrd(wallet, address, contentType, data)
    } else {
        txs = inscribeOrdChain(wallet, address, contentType, data)
    }


    for (let i = 0; i < txs.length; i++) {
        console.log(`broadcasting tx ${i+1} of ${txs.length}`)

        let tx = txs[i]

        await broadcast(tx)
    }

    console.log(txs[txs.length - 1].hash)
}


function inscribeOrd(wallet, address, contentType, data) {
    let txs = []


    let prefixHex = Buffer.from('ord').toString('hex')
    let contentTypeHex = Buffer.from(contentType).toString('hex')
    let inner = `${prefixHex} OP_1 ${contentTypeHex} OP_0 ${data.toString('hex')}`

    let pubkey = new PrivateKey(wallet.privkey).toPublicKey().toString()
    let lockScript = Script.fromASM(`${pubkey} OP_CHECKSIG OP_FALSE OP_IF ${inner} OP_ENDIF`)
    let lockScriptHash = Hash.ripemd160(Hash.sha256(lockScript.toBuffer()))

    let p2shOutputScript = Script.fromASM(`OP_HASH160 ${lockScriptHash.toString('hex')} OP_EQUAL`)
    let p2shOutput = new Transaction.Output({ script: p2shOutputScript, satoshis: 100000 })


    let tx1 = new Transaction()
    tx1.addOutput(p2shOutput)
    fund(wallet, tx1)
    updateWallet(wallet, tx1)

    txs.push(tx1)


    let p2shInput = new Transaction.Input({ prevTxId: tx1.hash, outputIndex: 0, output: tx1.outputs[0], script: '' })
    p2shInput.clearSignatures = () => {}
    p2shInput.getSignatures = () => {}


    let tx2 = new Transaction()
    tx2.addInput(p2shInput)
    tx2.to(address, 100000)
    fund(wallet, tx2)


    let signature = Transaction.sighash.sign(tx2, new PrivateKey(wallet.privkey), Signature.SIGHASH_ALL, 0, lockScript)
    let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])])
    let p2shInputScript = new Script().add(txsignature).add(lockScript.toBuffer())
    tx2.inputs[0].setScript(p2shInputScript)

    updateWallet(wallet, tx2)


    txs.push(tx2)


    return txs
}



const MAX_CHUNK_LEN = 255;
const MAX_PAYLOAD_LEN = MAX_SCRIPT_ELEMENT_SIZE - 34 - 5;

function inscribeOrdChain(wallet, address, contentType, data) {
    let txs = []


    const bufferToChunk = b => {
        return {
            buf: b.length ? b : undefined,
            len: b.length,
            opcodenum: b.length <= 75 ? b.length : b.length <= 255 ? 76 : 77
        }
    }

    const numberToChunk = n => {
        return {
            buf: n <= 16 ? undefined : n < 256 ? Buffer.from([n]) : Buffer.from([n / 256, n % 256]),
            len: n <= 16 ? 0 : n <= 255 ? 1 : 2,
            opcodenum: n == 0 ? 0 : n <= 16 ? 80 + n : n <= 255 ? 1 : 2
        }
    }


    let dataChunks = []
    while (data.length) {
        let part = data.slice(0, Math.min(MAX_CHUNK_LEN, data.length))
        let chunk = bufferToChunk(part)
        dataChunks.push(chunk)
        data = data.slice(part.length)
    }


    let inscriptionChunks = []
    inscriptionChunks.push(bufferToChunk(Buffer.from('ordchain')))
    inscriptionChunks.push(numberToChunk(dataChunks.length))
    inscriptionChunks.push(bufferToChunk(Buffer.from(contentType)))
    for (let i = 0; i < dataChunks.length; i++) {
        inscriptionChunks.push(numberToChunk(dataChunks.length - i - 1))
        inscriptionChunks.push(dataChunks[i])
    }


    let inscriptionChunksPerTx = []
    while (inscriptionChunks.length) {
        let chunks = []
        let length = 0;

        while (inscriptionChunks.length) {
            if (length + inscriptionChunks[0].len > MAX_PAYLOAD_LEN) {
                break
            }
            let chunk = inscriptionChunks.shift()
            chunks.push(chunk)
            length += chunk.len
        }

        inscriptionChunksPerTx.push(chunks)
    }


    let pubkey = new PrivateKey(wallet.privkey).toPublicKey().toString()


    let lockScripts = []
    for (let i = 0; i < inscriptionChunksPerTx.length; i++) {
        let lockScript = new Script()

        lockScript.chunks =
            Script.fromASM(`${pubkey} OP_CHECKSIG OP_FALSE OP_IF`).chunks
            .concat(inscriptionChunksPerTx[i])
            .concat(Script.fromASM(`OP_ENDIF`).chunks)

        lockScripts.push(lockScript)
    }


    for (let i = 0; i < inscriptionChunksPerTx.length; i++) {
        let lockScriptHash = Hash.ripemd160(Hash.sha256(lockScripts[i].toBuffer()))

        let p2shOutputScript = Script.fromASM(`OP_HASH160 ${lockScriptHash.toString('hex')} OP_EQUAL`)
        let p2shOutput = new Transaction.Output({ script: p2shOutputScript, satoshis: 100000 })

        let tx = new Transaction()
        tx.addOutput(p2shOutput)

        if (i > 0) {
            let prevtx = txs[i - 1]
            let prevlockScript = lockScripts[i - 1]

            let p2shInput = new Transaction.Input({ prevTxId: prevtx.hash, outputIndex: 0, output: prevtx.outputs[0], script: '' })
            p2shInput.clearSignatures = () => {}
            p2shInput.getSignatures = () => {}

            tx.addInput(p2shInput)

            fund(wallet, tx)

            let signature = Transaction.sighash.sign(tx, new PrivateKey(wallet.privkey), Signature.SIGHASH_ALL, 0, prevlockScript)
            let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])])
            let p2shInputScript = new Script().add(txsignature).add(prevlockScript.toBuffer())
            tx.inputs[0].setScript(p2shInputScript)

            updateWallet(wallet, tx)
        } else {
            fund(wallet, tx)
            updateWallet(wallet, tx)
        }

        txs.push(tx)
    }

    let tx = new Transaction()
    tx.to(address, 100000)

    let prevtx = txs[txs.length - 1]
    let prevlockScript = lockScripts[lockScripts.length - 1]

    let p2shInput = new Transaction.Input({ prevTxId: prevtx.hash, outputIndex: 0, output: prevtx.outputs[0], script: '' })
    p2shInput.clearSignatures = () => {}
    p2shInput.getSignatures = () => {}

    tx.addInput(p2shInput)

    fund(wallet, tx)

    let signature = Transaction.sighash.sign(tx, new PrivateKey(wallet.privkey), Signature.SIGHASH_ALL, 0, prevlockScript)
    let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])])
    let p2shInputScript = new Script().add(txsignature).add(prevlockScript.toBuffer())
    tx.inputs[0].setScript(p2shInputScript)

    updateWallet(wallet, tx)

    txs.push(tx)

    return txs
}


function fund(wallet, tx) {
    tx.change(wallet.address)
    delete tx._fee

    for (const utxo of wallet.utxos) {
        if (tx.inputs.length && tx.outputs.length && tx.inputAmount >= tx.outputAmount + tx.getFee()) {
            break
        }

        delete tx._fee
        tx.from(utxo)
        tx.change(wallet.address)
        tx.sign(wallet.privkey)
    }

    if (tx.inputAmount < tx.outputAmount + tx.getFee()) {
        throw new Error('not enough funds')
    }
}


function updateWallet(wallet, tx) {
    wallet.utxos = wallet.utxos.filter(utxo => {
        for (const input of tx.inputs) {
            if (input.prevTxId.toString('hex') == utxo.txid && input.outputIndex == utxo.vout) {
                return false
            }
        }
        return true
    })

    tx.outputs
        .forEach((output, vout) => {
            if (output.script.toAddress().toString() == wallet.address) {
                wallet.utxos.push({
                    txid: tx.hash,
                    vout,
                    script: output.script.toHex(),
                    satoshis: output.satoshis
                })
            }
        })
}


async function broadcast(tx) {
    const body = {
        jsonrpc: "1.0",
        id: 0,
        method: "sendrawtransaction",
        params: [tx.toString()]
    }

    const options = {
        auth: {
            username: process.env.NODE_RPC_USER,
            password: process.env.NODE_RPC_PASS
        }
    }

    while (true) {
        try {
            await axios.post(process.env.NODE_RPC_URL, body, options)
            break
        } catch (e) {
            let msg = e.response && e.response.data && e.response.data.error && e.response.data.error.message
            if (msg.includes('too-long-mempool-chain')) {
                console.warn('retrying, too-long-mempool-chain')
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                throw e
            }
        }
    }

    let wallet = JSON.parse(fs.readFileSync('.wallet.json'))

    updateWallet(wallet, tx)

    fs.writeFileSync('.wallet.json', JSON.stringify(wallet, 0, 2))
}


main().catch(e => console.error(e.toString(), e.response && e.response.data && e.response.data.error))
