# NSE Paper Trading

Broker-style paper trading platform for NSE stocks (work in progress — full README lands in Stage 4).

```bash
cp .env.example .env          # set MARKET_DATA_PROVIDER=fake to run offline
npm install
npm run seed                  # migrations + NIFTY 50 + price history + demo account
npm run dev:api
npm test
```
