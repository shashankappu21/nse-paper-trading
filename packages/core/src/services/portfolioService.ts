import type { HoldingDto, LedgerEntryDto, PortfolioDto } from '@nse/shared';
import type { Pool } from '../db/pool';
import { averagePrice, unrealisedPnl } from '../domain/portfolioMath';
import { getLogger } from '../logger';
import type { QuoteSource } from '../market/types';
import { toPaise, toRupees } from '../money';
import { holdingsRepo } from '../repositories/holdingsRepo';
import { ledgerRepo } from '../repositories/ledgerRepo';

export class PortfolioService {
  constructor(
    private readonly pool: Pool,
    private readonly quotes: QuoteSource,
  ) {}

  async getPortfolio(userId: string): Promise<PortfolioDto> {
    const [cash, all] = await Promise.all([ledgerRepo.balance(this.pool, userId), holdingsRepo.listForUser(this.pool, userId)]);
    const open = all.filter((h) => h.quantity > 0);

    let prices = new Map<string, { price: number }>();
    try {
      prices = await this.quotes.getQuotes(open.map((h) => h.symbol));
    } catch (err) {
      getLogger().warn({ err }, 'could not price portfolio');
    }

    let invested = 0;
    let current = 0;
    const holdings: HoldingDto[] = open.map((h) => {
      const q = prices.get(h.symbol);
      const ltp = q ? toPaise(q.price) : null;
      const value = ltp === null ? h.costBasis : h.quantity * ltp;
      invested += h.costBasis;
      current += value;
      return {
        symbol: h.symbol,
        name: h.name,
        quantity: h.quantity,
        avgPrice: toRupees(Math.round(averagePrice(h))),
        investedValue: toRupees(h.costBasis),
        lastPrice: ltp === null ? null : toRupees(ltp),
        currentValue: ltp === null ? null : toRupees(value),
        unrealisedPnl: ltp === null ? null : toRupees(unrealisedPnl(h, ltp)),
        realisedPnl: toRupees(h.realisedPnl),
      };
    });
    const realised = all.reduce((sum, h) => sum + h.realisedPnl, 0);

    return {
      cash: toRupees(cash),
      investedValue: toRupees(invested),
      currentValue: toRupees(current),
      unrealisedPnl: toRupees(current - invested),
      realisedPnl: toRupees(realised),
      totalValue: toRupees(cash + current),
      holdings,
    };
  }

  async getLedger(userId: string, limit = 100): Promise<LedgerEntryDto[]> {
    return (await ledgerRepo.list(this.pool, userId, limit)).map((r) => ({
      id: String(r.id),
      amount: Number(r.amount),
      reason: r.reason,
      orderId: r.order_id,
      createdAt: r.created_at.toISOString(),
    }));
  }
}
