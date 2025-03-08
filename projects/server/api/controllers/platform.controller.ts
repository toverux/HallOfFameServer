import { Controller, Get, Inject } from '@nestjs/common';
import { JsonList } from '../../common';
import { PrismaService } from '../../services';

@Controller('platform')
export class PlatformController {
  @Inject(PrismaService)
  private readonly prisma!: PrismaService;

  @Get('expense-income-records')
  public async getBalance(): Promise<JsonList> {
    const records = await this.prisma.expenseIncomeRecord.findMany();

    return records
      .sort((a, b) => b.processedAt.getTime() - a.processedAt.getTime())
      .map(record => ({
        id: record.id,
        processedAt: record.processedAt.toISOString(),
        amount: record.amount,
        description: record.description
      }));
  }
}
