# Zilliqa Stats Agent (Ethereum Network Intelligence API)

This is the backend service which runs along with Zilliqa and tracks the network status, fetches information through JSON-RPC and connects through WebSockets to [Protomainnet Network Status](https://stats.zq2-protomainnet.zilliqa.com/) to feed information. For full install instructions please read the [wiki](https://dev.zilliqa.com/zilliqa2/nodes/validatormonitoring/).

Zilliqa Network Status links:

- [Protomainnet Network Status](https://stats.zq2-protomainnet.zilliqa.com/)

- [Prototestnet Network Status](https://stats.zq2-prototestnet.zilliqa.com/)


## Prerequisites

Before proceeding, ensure you have the following:

- A running Zilliqa node.

- Docker installed on your system.

- Node installed on your system.

- Npm installed on your system.

- The required WebSocket secret (`WS_SECRET`) provided by Zilliqa to connect to the public status pages.


## Installation as docker container (recommended)

There is a `Dockerfile` in the root directory of the repository. Please read through the header of said file for
instructions on how to build/run/setup. Configuration instructions below still apply.

Run the following command to deploy the Zilliqa Stats Agent:

```bash
docker run -td --restart=unless-stopped \
    --platform=linux/amd64 \
    --net=host \
    -e RPC_HOST="127.0.0.1" \
    -e RPC_PORT="4202" \
    -e LISTENING_PORT="3333" \
    -e INSTANCE_NAME="validator-name" \
    -e CONTACT_DETAILS="your email address" \
    -e WS_SERVER="ws://stats.zq2-protomainnet.zilliqa.com" \
    -e WS_SECRET="<secret-value>" \
    -e VERBOSITY="2" \
    <image-name>
```

### Environment Variables

Customize the following environment variables based on your node and network setup:

- `RPC_HOST`: The IP address of your Zilliqa node's RPC interface. Default is `127.0.0.1`.

- `RPC_PORT`: The RPC admin port your Zilliqa node is listening on. Default is `4202`.

- `LISTENING_PORT`: The P2P communication port where the agent is listening. Default is `3333`.

- `INSTANCE_NAME`: A unique name for your node instance (e.g., "validator-1").

- `CONTACT_DETAILS`: Your contact email address for identification.

- `WS_SERVER`: WebSocket server URL for the stats page.

    - Use `ws://stats.zq2-protomainnet.zilliqa.com` for protomainnet.

    - Use `ws://stats.zq2-prototestnet.zilliqa.com` for prototestnet.

- `WS_SECRET`: The secret token provided by Zilliqa. **This is sensitive and confidential information. Please do not share it publicly or with unauthorized parties.**

- `VERBOSITY`: Logging verbosity level (default: `2`).

### Troubleshooting

1. **Issue:** The agent fails to connect to the WebSocket server.

    **Solution:** Verify the `WS_SECRET` and `WS_SERVER` values are correct.

2. **Issue:** Logs show the agent cannot reach the Zilliqa node.

    **Solution:** Ensure the `RPC_HOST` and `RPC_PORT` match your node's settings and are accessible.

For further assistance, please contact the Zilliqa team.
