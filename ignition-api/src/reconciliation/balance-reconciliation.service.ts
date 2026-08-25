import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { Horizon } from '@stellar/stellar-sdk';
import BigNumber from 'bignumber.js';
import { ReconciliationStatus } from '@prisma/client';

interface Wallet {
  id: string;
  stellarAddress: string;
  balance: string;
  isActive: boolean;
}

@Injectable()
export class BalanceReconciliationService {
  private readonly logger = new Logger(BalanceReconciliationService.name);
  private readonly horizonServer: Horizon.Server;

  constructor(private readonly prisma: PrismaService) {
    const horizonUrl =
      process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    this.horizonServer = new Horizon.Server(horizonUrl);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async reconcileWalletBalances(): Promise<void> {
    this.logger.log('Starting automated wallet balance reconciliation job...');

    const wallets = await this.prisma.wallet.findMany({
      where: { isActive: true },
      select: {
        id: true,
        depositAddress: true,
        balance: true,
        isActive: true,
      },
    });

    let flaggedCount = 0;

    for (const wallet of wallets) {
      try {
        const isDiscrepant = await this.reconcileWallet({
          id: wallet.id,
          stellarAddress: wallet.depositAddress,
          balance: wallet.balance.toString(),
          isActive: wallet.isActive,
        });
        if (isDiscrepant) {
          flaggedCount++;
        }
      } catch (error) {
        this.logger.error(
          `Failed to reconcile wallet ${wallet.id} (${wallet.depositAddress}):`,
          error.stack,
        );
      }
    }

    this.logger.log(
      `Reconciliation job finished. Scanned: ${wallets.length}, Flagged Discrepancies: ${flaggedCount}`,
    );
  }

  async reconcileWallet(wallet: Wallet): Promise<boolean> {
    const accountData = await this.horizonServer
      .loadAccount(wallet.stellarAddress)
      .catch((err) => {
        if (err?.response?.status === 404) {
          return null;
        }
        throw err;
      });

    const nativeAsset = accountData?.balances.find(
      (b) => b.asset_type === 'native',
    );
    const onChainBalance = new BigNumber(
      nativeAsset ? nativeAsset.balance : '0.0000000',
    );
    const dbBalance = new BigNumber(wallet.balance.toString());

    const driftAmount = dbBalance.minus(onChainBalance).abs();
    const DRIFT_THRESHOLD = new BigNumber('0.00001');

    if (driftAmount.isGreaterThan(DRIFT_THRESHOLD)) {
      this.logger.warn(
        `Balance drift detected for Wallet ${wallet.id}! DB: ${dbBalance.toFixed(7)}, On-Chain: ${onChainBalance.toFixed(7)}`,
      );

      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.balanceDiscrepancy.findFirst({
          where: {
            walletId: wallet.id,
            status: ReconciliationStatus.PENDING,
          },
        });

        if (existing) {
          await tx.balanceDiscrepancy.update({
            where: { id: existing.id },
            data: {
              dbBalance: dbBalance.toFixed(7),
              onChainBalance: onChainBalance.toFixed(7),
              driftAmount: driftAmount.toFixed(7),
            },
          });
        } else {
          await tx.balanceDiscrepancy.create({
            data: {
              walletId: wallet.id,
              stellarAddress: wallet.stellarAddress,
              dbBalance: dbBalance.toFixed(7),
              onChainBalance: onChainBalance.toFixed(7),
              driftAmount: driftAmount.toFixed(7),
              status: ReconciliationStatus.PENDING,
            },
          });
        }
      });

      return true;
    }

    return false;
  }
}
