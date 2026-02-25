const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

module.exports = {
  projectRoot,
  envFilePath: path.join(projectRoot, '.env'),
  dataDir: path.join(projectRoot, 'data'),
  uploadsDir: path.join(projectRoot, 'uploads'),
  publicDir: path.join(projectRoot, 'public'),
};
