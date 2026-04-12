module.exports = (req, res, next) => {
  try {
    const token = req.headers['x-admin-token'];

    if (!token) {
      return res.status(401).json({
        message: 'Admin token required'
      });
    }

    if (token !== process.env.ADMIN_ACCESS_TOKEN) {
      return res.status(403).json({
        message: 'Invalid admin token'
      });
    }

    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};