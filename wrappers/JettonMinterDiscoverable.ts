import { sha256_sync } from '@ton/crypto';

export function toSha256(s: string): bigint {
    return BigInt('0x' + sha256_sync(s).toString('hex'));
}

export function toTextSlice(): Slice {
    return beginCell().storeInt(-1, 1).endCell().beginParse();
}

export function toBoolean(): boolean {
    return true;
}

import {
    Address,
    beginCell,
    Cell,
    Dictionary,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano,
    internal as internal_relaxed,
    storeMessageRelaxed,
    Slice,
    fromNano,
} from '@ton/core';

import { Op } from './JettonConstants';

export type jettonMinterOnChainContent = {
    name: string;
    description: string;
    symbol: string;
    decimals: number;
    image: string;
};

export type JettonMinterOffChainContent = {
    type: 0 | 1;
    uri: string;
};

export type JettonMinterConfig = {
    admin: Address;
    content: Cell;
    wallet_code: Cell;
    blacklisted: Address;
    whitelist: Cell;
};
type JettonBalanceType = {
    pretty: string;
    num: number;
};

export function jettonMinterConfigToCell(config: JettonMinterConfig): Cell {
    return (
        beginCell()
            .storeCoins(0) // total supply
            .storeAddress(config.admin) // admin address
            .storeRef(config.content) // content
            .storeRef(config.wallet_code) // jetton wallet code
            .storeAddress(config.blacklisted) // blacklisted address
            .storeRef(config.whitelist) // whitelist dict
            // .storeRef(beginCell().endCell()) // whitelist dict
            .endCell()
    );
}

export function jettonOffChainContentToCell(content: JettonMinterOffChainContent) {
    return beginCell()
        .storeUint(content.type, 8)
        .storeStringTail(content.uri) //Snake logic under the hood
        .endCell();
}

export function toTextCell(s: string): Cell {
    return beginCell().storeUint(0, 8).storeStringTail(s).endCell();
}
export function toNumberCell(n: number): Cell {
    return beginCell().storeUint(1, 8).storeUint(n, 4).endCell();
}

export function jettonOnChainContentToCell(content: jettonMinterOnChainContent): Cell {
    const jettonMinterContentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
        .set(toSha256('name'), toTextCell(content.name))
        .set(toSha256('description'), toTextCell(content.description))
        .set(toSha256('symbol'), toTextCell(content.symbol))
        .set(toSha256('decimals'), toNumberCell(content.decimals))
        .set(toSha256('image'), toTextCell(content.image));

    return beginCell() // need to fix
        .storeUint(0, 8)
        .storeDict(jettonMinterContentDict)
        .endCell();
}

export function jettonContentOffChainToCell(content: JettonMinterOffChainContent) {
    return beginCell()
        .storeUint(content.type, 8)
        .storeStringTail(content.uri) //Snake logic under the hood
        .endCell();
}

export class JettonMinter implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new JettonMinter(address);
    }

    static createFromConfig(config: JettonMinterConfig, code: Cell, workchain = 0) {
        const data = jettonMinterConfigToCell(config);
        const init = { code, data };
        return new JettonMinter(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    protected static jettonInternalTransfer(
        jetton_amount: bigint,
        forward_ton_amount: bigint,
        response_addr?: Address,
        query_id: number | bigint = 0,
    ) {
        return beginCell()
            .storeUint(Op.internal_transfer, 32)
            .storeUint(query_id, 64)
            .storeCoins(jetton_amount)
            .storeAddress(null)
            .storeAddress(response_addr)
            .storeCoins(forward_ton_amount)
            .storeBit(false)
            .endCell();
    }
    static mintMessage(
        from: Address,
        to: Address,
        jetton_amount: bigint,
        forward_ton_amount: bigint,
        total_ton_amount: bigint,
        query_id: number | bigint = 0,
    ) {
        const mintMsg = beginCell()
            .storeUint(Op.internal_transfer, 32)
            .storeUint(0, 64)
            .storeCoins(jetton_amount)
            .storeAddress(to)
            .storeAddress(from) // Response addr
            .storeCoins(forward_ton_amount)
            .storeMaybeRef(null)
            .endCell();

        return beginCell()
            .storeUint(Op.mint, 32)
            .storeUint(query_id, 64) // op, queryId
            .storeAddress(to)
            .storeCoins(total_ton_amount)
            .storeCoins(jetton_amount)
            .storeRef(mintMsg)
            .endCell();
    }
    async sendMint(
        provider: ContractProvider,
        via: Sender,
        opts: {
            fromAddress: Address;
            toAddress: Address;
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
            .storeUint(Op.mint, 32) // op code for mint
            .storeUint(opts.queryId || 0, 64)
            .storeAddress(opts.toAddress)
            .storeCoins(opts.total_ton_amount)
            .storeCoins(opts.jettonAmount)
            .storeRef(
                beginCell()
                    .storeUint(Op.internal_transfer, 32) // op::internal_transfer
                    .storeUint(opts.queryId || 0, 64)
                    .storeCoins(opts.jettonAmount)
                    .storeAddress(this.address)
                    .storeAddress(opts.fromAddress) // response Addr
                    .storeCoins(opts.forward_ton_amount)
                    .storeBit(false) // flag for jetton minter excesses
                    .storeBit(false) // forward_payload in this case is empty
                    .endCell(),
            )
            .endCell();
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: messageBody,
            // body: JettonMinter.mintMessage(this.address, to, jetton_amount, forward_ton_amount, total_ton_amount),
            value: opts.total_ton_amount + toNano('0.015'),
            // value: total_ton_amount + toNano('0.015')
        });
    }

    /* provide_wallet_address#2c76b973 query_id:uint64 owner_address:MsgAddress include_address:Bool = InternalMsgBody;
     */
    static discoveryMessage(owner: Address, include_address: boolean) {
        return beginCell()
            .storeUint(0x2c76b973, 32)
            .storeUint(0, 64) // op, queryId
            .storeAddress(owner)
            .storeBit(include_address)
            .endCell();
    }

    async sendDiscovery(
        provider: ContractProvider,
        via: Sender,
        owner: Address,
        include_address: boolean,
        value: bigint = toNano('0.1'),
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.discoveryMessage(owner, include_address),
            value: value,
        });
    }

    static changeAdminMessage(newOwner: Address) {
        return beginCell()
            .storeUint(Op.change_admin, 32)
            .storeUint(0, 64) // op, queryId
            .storeAddress(newOwner)
            .endCell();
    }

    async sendChangeAdmin(provider: ContractProvider, via: Sender, newOwner: Address) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.changeAdminMessage(newOwner),
            value: toNano('0.05'),
        });
    }

    static changeBlacklistMessage(newBlacklisted: Address) {
        return beginCell()
            .storeUint(Op.set_blacklist, 32)
            .storeUint(0, 64) // op, queryId
            .storeAddress(newBlacklisted)
            .endCell();
    }

    async sendSetBlacklist(provider: ContractProvider, via: Sender, newBlacklisted: Address) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.changeBlacklistMessage(newBlacklisted),
            value: toNano('0.05'),
        });
    }
    async sendAddToWhitelist(
        provider: ContractProvider,
        via: Sender,
        opts: {
            whitelistedAddress: Address;
            queryId?: number;
        },
    ) {
        const messageBody = beginCell()
            .storeUint(Op.add_to_whitelist, 32) // op::add_to_whitelist
            .storeUint(opts.queryId || 0, 64)
            .storeAddress(opts.whitelistedAddress)
            .endCell();

        await provider.internal(via, {
            value: toNano('0.1'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: messageBody,
        });
    }

    async sendRemoveFromWhitelist(
        provider: ContractProvider,
        via: Sender,
        opts: {
            removedAddress: Address;
            queryId?: number;
        },
    ) {
        const messageBody = beginCell()
            .storeUint(Op.remove_from_whitelist, 32) // op::remove_from_whitelist
            .storeUint(opts.queryId || 0, 64)
            .storeAddress(opts.removedAddress)
            .endCell();

        await provider.internal(via, {
            value: toNano('0.1'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: messageBody,
        });
    }

    async sendCheckBlacklist(
        provider: ContractProvider,
        via: Sender,
        opts: {
            checkAddress: Address;
            queryId?: number;
        },
    ) {
        const messageBody = beginCell()
            .storeUint(Op.check_blacklist, 32) // op::check_blacklist
            .storeUint(opts.queryId || 0, 64)
            .storeAddress(opts.checkAddress)
            .endCell();

        await provider.internal(via, {
            value: toNano('0.1'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: messageBody,
        });
    }

    async sendCheckWhitelist(
        provider: ContractProvider,
        via: Sender,
        opts: {
            checkAddress: Address;
            queryId?: number;
        },
    ) {
        const messageBody = beginCell()
            .storeUint(Op.check_whitelist, 32) // op::check_whitelist
            .storeUint(opts.queryId || 0, 64)
            .storeAddress(opts.checkAddress)
            .endCell();

        await provider.internal(via, {
            value: toNano('0.1'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: messageBody,
        });
    }

    static changeContentMessage(content: Cell) {
        return beginCell()
            .storeUint(Op.change_content, 32)
            .storeUint(0, 64) // op, queryId
            .storeRef(content)
            .endCell();
    }

    async sendChangeContent(provider: ContractProvider, via: Sender, content: Cell) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.changeContentMessage(content),
            value: toNano('0.05'),
        });
    }

    static withdrawTonMessage(amount: bigint) {
        return beginCell()
            .storeUint(Op.withdraw_ton, 32)
            .storeUint(0, 64) // op, queryId
            .storeCoins(amount)
            .endCell();
    }

    async sendWithdrawTons(provider: ContractProvider, via: Sender, amount: bigint) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.withdrawTonMessage(amount),
            value: toNano('0.05'),
        });
    }
    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const res = await provider.get('get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return res.stack.readAddress();
    }

    async getJettonData(provider: ContractProvider) {
        let res = await provider.get('get_jetton_data', []);
        let totalSupply = res.stack.readBigNumber();
        let mintable = res.stack.readBoolean();
        let adminAddress = res.stack.readAddress();
        let content = res.stack.readCell();
        let walletCode = res.stack.readCell();
        return {
            totalSupply,
            mintable,
            adminAddress,
            content,
            walletCode,
        };
    }

    async getTotalSupply(provider: ContractProvider) {
        let res = await this.getJettonData(provider);
        return res.totalSupply;
    }
    async getAdminAddress(provider: ContractProvider) {
        let res = await this.getJettonData(provider);
        return res.adminAddress;
    }
    async getContent(provider: ContractProvider) {
        let res = await this.getJettonData(provider);
        return res.content;
    }
    async get_blacklisted_address(provider: ContractProvider) {
        let res = await provider.get('get_blacklisted_address', []);
        let blacklistAddress = res.stack.readAddress();
        return {
            blacklistAddress,
        };
    }
    // async get_whitelist(provider: ContractProvider) {
    //     let res = await provider.get('get_whitelist', []);
    //     let whitelist = res.stack.readCell();
    //     return {
    //         whitelist,
    //     };
    // }
    async get_whitelist(provider: ContractProvider): Promise<Address[]> {
        const result = await provider.get('get_whitelist', []);
        const whitelistCell = result.stack.readCell();
        return this.parseWhitelistDictionary(whitelistCell);
    }

    async getBalance(provider: ContractProvider): Promise<JettonBalanceType> {
        const result = await provider.get('get_ton_balance', []);
        const balance = result.stack.readBigNumber();
        return { pretty: `${fromNano(balance)} TON`, num: Number(balance) };
    }

    private parseWhitelistDictionary(cell: Cell): Address[] {
        let dict: Dictionary<bigint, boolean>;
        try {
            const slice = cell.beginParse();
            if (slice.remainingRefs === 0) {
                console.log('Whitelist is empty or not initialized.');
                return [];
            }
            dict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.Bool(), slice.loadRef());
        } catch (error) {
            console.error('Error parsing whitelist dictionary:', error);
            return [];
        }

        const addresses: Address[] = [];

        for (const [key, value] of dict) {
            if (value) {
                try {
                    const address = this.keyToAddress(key);
                    addresses.push(address);
                } catch (error) {
                    console.error('Error converting key to address:', error);
                }
            }
        }

        return addresses;
    }

    private keyToAddress(key: bigint): Address {
        // Construct a 256-bit integer from the 267-bit key
        const addressInt = key & ((1n << 256n) - 1n);

        // Convert to a 32-byte buffer
        const buffer = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) {
            buffer[31 - i] = Number((addressInt >> BigInt(i * 8)) & 0xffn);
        }

        // Create an Address instance
        return new Address(0, buffer); // Assuming workchain 0
    }
}
