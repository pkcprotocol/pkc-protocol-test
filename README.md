This repo contains extra tests for `pkc-js` (https://github.com/pkcprotocol/pkc-js) to ensure no protocol regression.

#### Install

- `npm install`

#### Node tests

- `npm run test`

#### Watch node tests

- `npm run test:watch`

#### Install Playwright browsers (first run)

- `npx playwright install --with-deps chromium firefox`

#### Browser tests

- `npm run test:browser`

#### Tests with pkc-js logs

```
DEBUG=pkc-js:* npm run test
```
