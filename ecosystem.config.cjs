// PM2 process config. Uses .cjs because package.json sets "type": "module".
module.exports = {
  apps: [
    {
      name: "mcp-azure-devops",
      script: "src/server.js",
      instances: "max",
      exec_mode: "cluster",
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
    },
  ],
};
