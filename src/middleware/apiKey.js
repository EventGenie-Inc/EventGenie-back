module.exports = (req, res, next) => {
  if (req.query.apiKey !== process.env.REPORT_API_KEY) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};