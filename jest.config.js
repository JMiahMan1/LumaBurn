module.exports = {
  testMatch: ['**/*.test.mjs', '**/*.test.js'],
  transform: {
    '^.+\\.m?js$': 'babel-jest',
  },
  babelConfig: {
    presets: [
      ['@babel/preset-env', { targets: { node: 'current' } }],
    ],
  },
  testEnvironment: 'node',
  collectCoverageFrom: ['**/*.mjs', '**/*.js', '!**/node_modules/**', '!**/dist/**'],
};
