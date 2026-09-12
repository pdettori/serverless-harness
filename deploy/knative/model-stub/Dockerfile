# P6 model stub (spec §5.4): an Anthropic-compatible SSE service with a configurable
# time-to-first-token, inter-token delay, output length, and TOOL-CALL RATE. Both E9 arms drive
# this same image so the comparison varies the deployment tier and nothing else (§5.3).
# Self-built (dev.local/model-stub:p6) and kind/podman-loaded — no registry pull by the cluster.
FROM node:20-alpine
COPY stub.js /stub.js
EXPOSE 8080
# Non-root, like echo-target: the server binds :8080, so no privileged port is needed.
USER node
CMD ["node", "/stub.js"]
