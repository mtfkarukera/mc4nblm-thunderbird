const fs = require('fs');
const path = require('path');

let ignoreFiles = [];
try {
  const ignorePath = path.join(__dirname, '.web-ext-ignore');
  if (fs.existsSync(ignorePath)) {
    const ignoreContent = fs.readFileSync(ignorePath, 'utf8');
    ignoreFiles = ignoreContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  }
} catch (e) {
  console.error('[MC] Error reading .web-ext-ignore in config:', e);
}

module.exports = {
  ignoreFiles: ignoreFiles
};
