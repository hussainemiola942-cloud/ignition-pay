import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { BalanceReconciliationService } from './balance-reconciliation.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
  ],
  providers: [BalanceReconciliationService],
  exports: [BalanceReconciliationService],
})
export class ReconciliationModule {}
