const axios = require("axios");
const env = require("../config/env");

const getAuth = () => ({
  username: "",
  password: env.AZURE_PAT
});

const retry = async (fn, retries = 3) => {
  try {
    return await fn();
  } catch (err) {
    if (retries === 0) throw err;
    return retry(fn, retries - 1);
  }
};

exports.getLogs = async (buildId) => {
  const url = `https://dev.azure.com/${env.AZURE_ORG}/${env.AZURE_PROJECT}/_apis/build/builds/${buildId}/logs?api-version=7.0`;

  const res = await retry(() =>
    axios.get(url, { auth: getAuth() })
  );

  return res.data;
};

exports.getLogContent = async (buildId, logId) => {
  const url = `https://dev.azure.com/${env.AZURE_ORG}/${env.AZURE_PROJECT}/_apis/build/builds/${buildId}/logs/${logId}?api-version=7.0`;

  const res = await retry(() =>
    axios.get(url, {
      auth: getAuth(),
      headers: { Accept: "text/plain" },
      responseType: "text"
    })
  );

  // 🔥 CRITICAL CHECK
  if (res.data.includes("<!DOCTYPE html>")) {
    throw new Error("Azure returned HTML → auth issue");
  }

  return res.data.split("\n");
};