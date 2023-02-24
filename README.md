# Doginals

A protocol and minter for inscriptions on Dogecoin. 

## Setup

Install dependencies:

```sh
npm install
```

Create a `.env` file with your node information:

```
NODE_RPC_URL=http://<ip:port>
NODE_RPC_USER=<username>
NODE_RPC_PASS=<password>
TESTNET=false
```

## Funding

Generate a new `.wallet.json` file:

```
node . wallet new
```

Then send DOGE to the address displayed. Once sent, sync your wallet:

```
node . wallet sync
```

If you are minting a lot, you can split up your UTXOs:

```
node . wallet split <count>
```

When you are done minting, send the funds back:

```
node . wallet send <address> <optional amount>
```

## Minting

```
node . mint <address> <content type> <hex data OR filename>
```

Example:

```
node . mint DSV12KPb8m5b6YtfmqY89K6YqvdVwMYDPn "text/plain;charset=utf8" 576f6f6621 
node . mint DSV12KPb8m5b6YtfmqY89K6YqvdVwMYDPn dog.jpeg
```

## Protocol

todo
