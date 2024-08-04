import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    fromNano,
    Sender,
    SendMode,
    toNano,
} from '@ton/core';

import { randomBytes } from 'crypto';

import { Op } from './JettonConstants';

export type JettonWalletConfig = {};

type JettonBalanceType = {
    pretty: string;
    num: number;
};

export function jettonWalletConfigToCell(config: JettonWalletConfig): Cell {
    return beginCell().endCell();
}

export class JettonWallet implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new JettonWallet(address);
    }

    static createFromConfig(config: JettonWalletConfig, code: Cell, workchain = 0) {
        const data = jettonWalletConfigToCell(config);
        const init = { code, data };
        return new JettonWallet(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendOpDecreaseBalance(
        provider: ContractProvider,
        via: Sender,
        opts: {
            fromAddress: Address;
            jettonAmount: bigint;
            forward_ton_amount: bigint;
            total_ton_amount: bigint;
            queryId?: number;
        },
    ) {
        if (opts.total_ton_amount <= opts.forward_ton_amount) {
            throw new Error('Total ton amount should be > forward amount');
        }

        const messageBody = beginCell()
            .storeUint(Op.decrease_balance, 32) // op code for mint
            .storeUint(opts.queryId || 0, 64)
            .storeCoins(opts.jettonAmount)
            .storeAddress(opts.fromAddress)
            .storeCoins(opts.total_ton_amount)
            .storeBit(false) // forward_payload in this case is empty
            .endCell();
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: messageBody,
            value: opts.total_ton_amount + toNano('0.015'),
        });
    }

    async getJettonBalance(provider: ContractProvider) {
        let state = await provider.getState();
        if (state.state.type !== 'active') {
            return 0n;
        }
        let res = await provider.get('get_wallet_data', []);
        return res.stack.readBigNumber();
    }
    static transferMessage(
        jetton_amount: bigint,
        to: Address,
        responseAddress: Address,
        customPayload: Cell | null,
        forward_ton_amount: bigint,
        forwardPayload: Cell | null,
    ) {
        const queryId = this.randomQueryId();

        return beginCell()
            .storeUint(Op.transfer, 32) // op
            .storeUint(queryId, 64) // queryId
            .storeCoins(jetton_amount)
            .storeAddress(to)
            .storeAddress(responseAddress)
            .storeMaybeRef(customPayload)
            .storeCoins(forward_ton_amount)
            .storeMaybeRef(forwardPayload)
            .endCell();
    }
    async sendTransfer(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        jetton_amount: bigint,
        to: Address,
        responseAddress: Address | null,
        customPayload: Cell,
        forward_ton_amount: bigint,
        forwardPayload: Cell,
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.transferMessage(
                jetton_amount,
                to,
                responseAddress!,
                customPayload,
                forward_ton_amount,
                forwardPayload,
            ),
            value: value,
        });
    }
    /*
      burn#595f07bc query_id:uint64 amount:(VarUInteger 16)
                    response_destination:MsgAddress custom_payload:(Maybe ^Cell)
                    = InternalMsgBody;
    */
    static burnMessage(jetton_amount: bigint, responseAddress: Address, customPayload: Cell | null) {
        const queryId = this.randomQueryId();

        return beginCell()
            .storeUint(0x595f07bc, 32)
            .storeUint(0, 64) // op, queryId
            .storeCoins(jetton_amount)
            .storeAddress(responseAddress)
            .storeMaybeRef(customPayload)
            .endCell();
    }

    async sendBurn(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        jetton_amount: bigint,
        responseAddress: Address,
        customPayload: Cell,
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.burnMessage(jetton_amount, responseAddress, customPayload),
            value: value,
        });
    }
    /*
      withdraw_tons#107c49ef query_id:uint64 = InternalMsgBody;
    */
    static withdrawTonsMessage() {
        const queryId = this.randomQueryId();

        return beginCell()
            .storeUint(0x6d8e5e3c, 32)
            .storeUint(queryId, 64) // op, queryId
            .endCell();
    }

    async sendWithdrawTons(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.withdrawTonsMessage(),
            value: toNano('0.1'),
        });
    }
    /*
      withdraw_jettons#10 query_id:uint64 wallet:MsgAddressInt amount:Coins = InternalMsgBody;
    */
    static withdrawJettonsMessage(from: Address, amount: bigint) {
        const queryId = this.randomQueryId();

        return beginCell()
            .storeUint(0x768a50b2, 32)
            .storeUint(queryId, 64) // op, queryId
            .storeAddress(from)
            .storeCoins(amount)
            .storeMaybeRef(null)
            .endCell();
    }

    async sendWithdrawJettons(provider: ContractProvider, via: Sender, from: Address, amount: bigint) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonWallet.withdrawJettonsMessage(from, amount),
            value: toNano('0.1'),
        });
    }

    static randomQueryId(): bigint {
        // Генерируем 8 случайных байтов (64 бита)
        const randomBuffer = randomBytes(8);

        // Преобразуем байты в BigInt
        return BigInt(`0x${randomBuffer.toString('hex')}`);
    }

    async getBalance(provider: ContractProvider): Promise<JettonBalanceType> {
        const result = await provider.get('get_ton_balance', []);
        const balance = result.stack.readBigNumber();
        return { pretty: `${fromNano(balance)} TON`, num: Number(balance) };
    }
}
