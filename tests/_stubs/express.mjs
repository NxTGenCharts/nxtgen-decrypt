// Test-only stand-in for `express` so the route layer can be exercised without installing it.
const express = () => ({});
express.json = () => (req, res, next) => next();
export default express;
