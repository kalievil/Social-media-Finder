// Simple root endpoint to verify the server is running
module.exports = (req, res) => {
  res.json({
    message: 'Social Media Finder API is running',
    endpoints: {
      search: '/api/search-image'
    }
  });
}; 