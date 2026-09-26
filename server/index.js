'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || undefined; // default: all interfaces

createApp().listen(port, host, () => {
  console.log(`Guess the Song running at http://localhost:${port}`);
});
