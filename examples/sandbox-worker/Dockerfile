# Container image for the sandbox exec service. The base image ships the agent
# @cloudflare/sandbox talks to; add whatever toolchain your agents need on top.
FROM docker.io/cloudflare/sandbox:0.7.0

# Example: give agent code a Python as well as the bundled Node.
# RUN apt-get update && apt-get install -y --no-install-recommends python3 \
#     && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
