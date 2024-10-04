import assert from 'node:assert/strict';
import { Inject, Provider } from '@nestjs/common';
import chalk from 'chalk';
import { oneLine } from 'common-tags';
import * as dateFns from 'date-fns';
import {
    Command,
    CommandRunner,
    InquirerService,
    Question,
    QuestionSet
} from 'nest-commander';
import { PrismaService } from '../../services';

@Command({
    name: 'balance',
    description: `Interactive command to add expense or income records to the database.`
})
class BalanceCommand extends CommandRunner {
    @Inject(InquirerService)
    private readonly inquirer!: InquirerService;

    @Inject(PrismaService)
    private readonly prisma!: PrismaService;

    public override async run(): Promise<void> {
        const record = await this.inquirer.ask<BalanceQuestionsResult>(
            'balance',
            undefined
        );

        await this.prisma.expenseIncomeRecord.create({
            data: record
        });

        const {
            _sum: { amount }
        } = await this.prisma.expenseIncomeRecord.aggregate({
            _sum: {
                amount: true
            }
        });

        assert(amount != null);

        process.stdout.write(
            chalk.bold(
                `Record added successfully!\n${chalk[
                    amount < 0 ? 'redBright' : 'greenBright'
                ](`Total balance: $${(amount / 100).toFixed(2)}\n`)}`
            )
        );
    }
}

interface BalanceQuestionsResult {
    description: string;
    amount: number;
    processedAt: Date;
}

@QuestionSet({ name: 'balance' })
class BalanceQuestions {
    @Question({
        name: 'description',
        message: `Short description for the transaction:`
    })
    public parseDescription(val: string): string {
        const description = val.trim();
        if (!description) {
            // biome-ignore lint/style/useThrowOnlyError: normal pattern w/Commander
            throw `Transaction description must not be empty.`;
        }

        return description;
    }

    @Question({
        name: 'amount',
        message: `Amount of the transaction (negative or positive), in cents:`,
        type: 'number'
    })
    public parseAmount(val: number): number {
        if (Number.isNaN(val) || val == 0) {
            // biome-ignore lint/style/useThrowOnlyError: normal pattern w/Commander
            throw `Invalid amount.`;
        }

        return val;
    }

    @Question({
        name: 'processedAt',
        message: oneLine`
            What was the date of the transaction?
            Leave empty to use the current date.
            (ddmmyy):`
    })
    public parseProcessedAt(val: string): Date {
        if (!val.trim()) {
            return new Date();
        }

        const date = dateFns.parse(val.trim(), 'ddMMyy', new Date());

        if (!dateFns.isValid(date)) {
            // biome-ignore lint/style/useThrowOnlyError: normal pattern w/Commander
            throw `Invalid date format, please use ddmmyy.`;
        }

        return date;
    }
}

export const balanceCommandProviders: Provider[] = [
    BalanceCommand,
    BalanceQuestions
];
