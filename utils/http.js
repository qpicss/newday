// Log the real error server-side and return only a generic message to the client.
const sendServerError = (res, error, message = 'Internal server error') => {
  console.error(error);
  res.status(500).json({ error: message });
};

module.exports = { sendServerError };
