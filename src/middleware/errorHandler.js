module.exports = (err, req, res, next) => {
  console.error(`ERROR [${req.id}]:`, err.message);

  res.status(err.status || 500).json({
    requestId: req.id,
    error: err.message
  });
};