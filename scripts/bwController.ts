import { Address, beginCell, Cell, fromNano, OpenedContract, toNano } from '@ton/core';
import { compile, sleep, NetworkProvider, UIProvider } from '@ton/blueprint';
import { JettonMinter } from '../wrappers/JettonMinterDiscoverable';
import { JettonWallet } from '../wrappers/JettonWallet';
import {
    promptBool,
    promptAmount,
    promptWithdrawAmount,
    promptAddress,
    displayContentCell,
    waitForTransaction,
} from '../wrappers/ui-utils';
import { randomBytes } from 'crypto';
import { SandboxContract } from '@ton/sandbox';
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton';

let minterContract: OpenedContract<JettonMinter>;
let walletContract: OpenedContract<JettonWallet>;
let userWallet: (address: Address) => Promise<OpenedContract<JettonWallet>>;

const adminActions = [
    'Set blacklist address',
    'Add address to whitelist',
    'Remove address from whitelist',
    'Mint',
    'Transfer',
    'Withdraw TON from Jetton Minter (Jetton Master)',
];
const userActions = [
    'Get blacklist address',
    // 'Check blacklist address',
    'Get whitelist address(es)',
    // 'Check whitelist address',
    'Jetton info',
    'Quit',
];

// const sleep = (ms: number) => {
//     return new Promise((resolve) => setTimeout(resolve, ms));
// };

const failedTransMessage = (ui: UIProvider) => {
    ui.write('Failed to get indication of transaction completion from API!\nCheck result manually, or try again\n');
};

const infoAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const jettonData = await minterContract.getJettonData();
    ui.write('Jetton info:\n\n');
    ui.write(`Admin:${jettonData.adminAddress}\n`);
    ui.write(`Total supply:${fromNano(jettonData.totalSupply)}\n`);
    ui.write(`Mintable:${jettonData.mintable}\n`);
    const displayContent = await ui.choose('Display content?', ['Yes', 'No'], (c) => c);
    if (displayContent == 'Yes') {
        displayContentCell(jettonData.content, ui);
    }
};
const changeAdminAction = async (provider: NetworkProvider, ui: UIProvider) => {
    let retry: boolean;
    let newAdmin: Address;
    let curAdmin = await minterContract.getAdminAddress();
    do {
        retry = false;
        newAdmin = await promptAddress('Please specify new admin address:', ui);
        if (newAdmin.equals(curAdmin)) {
            retry = true;
            ui.write('Address specified matched current admin address!\nPlease pick another one.\n');
        } else {
            ui.write(`New admin address is going to be:${newAdmin}\nKindly double check it!\n`);
            retry = !(await promptBool('Is it ok?(yes/no)', ['yes', 'no'], ui));
        }
    } while (retry);

    const getLastSeqno = (await provider.api().getLastBlock()).last.seqno;
    const curState = (await provider.api().getAccount(getLastSeqno, minterContract.address)).account;
    if (curState.last === null) throw "Last transaction can't be null on deployed contract";

    await minterContract.sendChangeAdmin(provider.sender(), newAdmin);
    const transDone = await waitForTransaction(provider, minterContract.address, curState.last.lt, 10);
    if (transDone) {
        const adminAfter = await minterContract.getAdminAddress();
        if (adminAfter.equals(newAdmin)) {
            ui.write('Admin changed successfully');
        } else {
            ui.write("Admin address hasn't changed!\nSomething went wrong!\n");
        }
    } else {
    }
};

const mintAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender = provider.sender();
    let retry: boolean;
    let mintAddress: Address;
    let mintAmount: string;
    // let forwardAmount: string;

    do {
        retry = false;
        const fallbackAddr = sender.address ?? (await minterContract.getAdminAddress());
        mintAddress = await promptAddress(`Please specify address to mint to`, ui, fallbackAddr);
        mintAmount = await promptAmount('Please provide mint amount:', ui);
        ui.write(`Mint ${mintAmount} tokens to ${mintAddress}\n`);
        retry = !(await promptBool('Is it ok?(yes/no)', ['yes', 'no'], ui));
    } while (retry);

    ui.write(`Minting ${mintAmount} to ${mintAddress}\n`);
    const supplyBefore = await minterContract.getTotalSupply();
    const nanoMint = toNano(mintAmount);
    console.log(nanoMint);
    const mintFees = toNano('0.05');
    const forwardAmount = toNano('0.1');
    const totalTonAmount = forwardAmount + mintFees;
    const getLastSeqno = (await provider.api().getLastBlock()).last.seqno;
    const curState = (await provider.api().getAccount(getLastSeqno, minterContract.address)).account;

    if (curState.last === null) throw "Last transaction can't be null on deployed contract";

    const queryId = randomQueryId();

    const res = await minterContract.sendMint(sender, {
        fromAddress: mintAddress, // кто отправляет, админ provider.sender(), wallet_mnemonic address
        toAddress: mintAddress, // к кому отправить монеты
        jettonAmount: nanoMint,
        forward_ton_amount: toNano('0.05'),
        total_ton_amount: toNano('0.1'),
        queryId,
    });
    const gotTrans = await waitForTransaction(provider, minterContract.address, curState.last.lt, 30);
    if (gotTrans) {
        const supplyAfter = await minterContract.getTotalSupply();

        if (supplyAfter == supplyBefore + nanoMint) {
            ui.write('Mint successfull!\nCurrent supply:' + supplyAfter);
        } else {
            ui.write('Mint failed!');
        }
    } else {
        failedTransMessage(ui);
    }
};
const transferAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender = provider.sender();
    let retry: boolean;
    let transferAddress: Address;
    let transferAmount: string;

    // let forwardAmount: string;

    do {
        retry = false;
        // const fallbackAddr = sender.address ?? (await minterContract.getAdminAddress());
        transferAddress = await promptAddress(`Please specify address to transfer to`, ui);
        transferAmount = await promptAmount('Please provide transfer amount:', ui);
        ui.write(`Transfer ${Number(transferAmount)} tokens to ${transferAddress}\n`);
        retry = !(await promptBool('Is it ok?(yes/no)', ['yes', 'no'], ui));
    } while (retry);

    ui.write(`Transfering ${Number(transferAmount)} to ${transferAddress}\n`);

    const mintFees = toNano('0.6');
    const forwardAmount = toNano('0.000000001');
    const totalTonAmount = forwardAmount + mintFees;
    const getLastSeqno = (await provider.api().getLastBlock()).last.seqno;
    const curState = (await provider.api().getAccount(getLastSeqno, walletContract.address)).account;

    if (curState.last === null) throw "Last transaction can't be null on deployed contract";
    const jettonBalanceBefore = await (await userWallet(sender.address!)).getJettonBalance();
    const res = await walletContract.sendTransfer(
        sender,
        toNano('0.05'), //tons
        BigInt(Number(transferAmount)),
        transferAddress,
        sender.address!, //sender.address!
        // deployer.address,
        beginCell().endCell(),
        forwardAmount,
        beginCell().endCell(),
    );
    const gotTrans = await waitForTransaction(provider, walletContract.address, curState.last.lt, 30);
    if (gotTrans) {
        const jettonBalanceAfter = await (await userWallet(sender.address!)).getJettonBalance();
        const toTrasnferedJettonWallet = await userWallet(transferAddress);
        // const toTransferedJettonWalletBalance = toTrasnferedJettonWallet.getJettonBalance();
        const toTransferedJettonWalletBalance = await toTrasnferedJettonWallet.getJettonBalance();
        console.log('jettonBalanceBefore', jettonBalanceBefore);
        console.log('jettonBalanceAfter', jettonBalanceAfter);
        console.log('toTransferedJettonWalletBalance', toTransferedJettonWalletBalance);
        console.log('BigInt(Number(transferAmount))', BigInt(Number(transferAmount)));
        let isJettonBalanceUpdated = jettonBalanceAfter == jettonBalanceBefore - BigInt(Number(transferAmount));

        if (isJettonBalanceUpdated) {
            ui.write(
                `Transfer successfull!\nCurrent balance: ${jettonBalanceAfter}\nTransfered Balance: ${toTransferedJettonWalletBalance}`,
            );
        } else {
            ui.write('Transfer failed!');
        }
    } else {
        failedTransMessage(ui);
    }
};
const withdrawAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender = provider.sender();
    let retry: boolean;
    let withdrawAmount: string;

    // let forwardAmount: string;
    ui.write(`Please don't type anything, trying to get balance of Jetton Minter...`);
    const jettonMinterTonBalancePretty = (await minterContract.getBalance()).pretty;
    const jettonMinterTonBalanceNum = (await minterContract.getBalance()).num;
    ui.write(`Available amount: ${jettonMinterTonBalancePretty}`);
    do {
        retry = false;
        withdrawAmount = await promptWithdrawAmount('Please provide withdraw amount (eg. 1.234):', ui);
        if (toNano(withdrawAmount) > jettonMinterTonBalanceNum) {
            ui.write(
                `Insufficent TON balance at JettonMinter (${jettonMinterTonBalancePretty}), please reduce amount to withdraw (eg. 1.234)...\n`,
            );
            retry = true;
        } else if (!toNano(withdrawAmount)) {
            ui.write(`Hm, withdraw zero, for what? Please provide amount greater than zero (eg. 1.234)...\n`);
            retry = true;
        } else if (toNano(withdrawAmount) < 0) {
            ui.write(`Cannot withdraw negative amount. Please provide amount greater than zero (eg. 1.234)...\n`);
            retry = true;
        } else {
            ui.write(`Withdraw ${Number(withdrawAmount)} tokens to ${sender.address}\n`);
            retry = !(await promptBool('Is it ok?(yes/no)', ['yes', 'no'], ui));
        }
    } while (retry);
    ui.write(`Withdrawing ${Number(withdrawAmount)} to ${sender.address}\n`);

    const getLastSeqno = (await provider.api().getLastBlock()).last.seqno;
    const curState = (await provider.api().getAccount(getLastSeqno, minterContract.address)).account;

    if (curState.last === null) throw "Last transaction can't be null on deployed contract";
    const jettonMinterTonBalanceBefore = (await minterContract.getBalance()).num;

    const res = await minterContract.sendWithdrawTons(sender, toNano(withdrawAmount));

    const gotTrans = await waitForTransaction(provider, minterContract.address, curState.last.lt, 30);
    if (gotTrans) {
        const jettonMinterTonBalanceAfter = (await minterContract.getBalance()).num;

        const isMinterBalanceWithdrew = jettonMinterTonBalanceAfter < jettonMinterTonBalanceBefore;

        if (isMinterBalanceWithdrew) {
            const senderTonBalance = (await provider.api().getAccount(getLastSeqno, sender.address!)).account.balance
                .coins;
            ui.write(
                `Withdrawing successfull!\nCurrent balance: ${fromNano(senderTonBalance)} TON\nJetton Minter Balance: ${fromNano(jettonMinterTonBalanceAfter)} TON`,
            );
        } else {
            ui.write('Withdrawing failed!');
        }
    } else {
        failedTransMessage(ui);
    }
};
const addToWhitelistAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender = provider.sender();
    let retry: boolean;
    let mintAddress: Address;
    let mintAmount: string;
    // let forwardAmount: string;
    let newWhitelistedAddress: Address;

    do {
        retry = false;
        const whitelistBefore = await minterContract.get_whitelist();
        const zeroAddress = Address.parseRaw('0:0000000000000000000000000000000000000000000000000000000000000000');
        // const fallbackAddr = blacklistedBefore.blacklistAddress;

        newWhitelistedAddress = await promptAddress(`Please specify address to add to whitelist`, ui);
        ui.write(`You want to add ${newWhitelistedAddress} to whitelist?\n`);
        retry = !(await promptBool('Is it ok?(y/n)', ['y', 'n'], ui));
    } while (retry);

    ui.write(`Adding ${newWhitelistedAddress} to whitelist\n`);
    const mintFees = toNano('0.05');
    const forwardAmount = toNano('0.1');
    const totalTonAmount = forwardAmount + mintFees;
    const getLastSeqno = (await provider.api().getLastBlock()).last.seqno;
    const curState = (await provider.api().getAccount(getLastSeqno, minterContract.address)).account;
    const queryId = randomQueryId();

    if (curState.last === null) throw "Last transaction can't be null on deployed contract";
    const res = await minterContract.sendAddToWhitelist(provider.sender(), {
        whitelistedAddress: newWhitelistedAddress,
        queryId,
    });
    const gotTrans = await waitForTransaction(provider, minterContract.address, curState.last.lt, 30);
    if (gotTrans) {
        const whitelist = await minterContract.get_whitelist();
        if (whitelist.toString().includes(newWhitelistedAddress.toString())) {
            let whitelistAddresses: string = '';
            for (const address of whitelist) {
                whitelistAddresses += `${address.toString()}\n`;
            }
            ui.write('Whitelist succesfully updated!\nCurrent whitelist dictionary:\n' + whitelistAddresses);
        } else {
            ui.write('Adding to whitelist failed!');
        }
    } else {
        failedTransMessage(ui);
    }
};
const removeFromWhitelistAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender = provider.sender();
    let retry: boolean;
    let mintAddress: Address;
    let mintAmount: string;
    // let forwardAmount: string;
    let newWhitelistedAddress: Address;

    do {
        retry = false;
        const whitelistBefore = await minterContract.get_whitelist();
        const zeroAddress = Address.parseRaw('0:0000000000000000000000000000000000000000000000000000000000000000');
        // const fallbackAddr = blacklistedBefore.blacklistAddress;

        newWhitelistedAddress = await promptAddress(`Please specify address to remove from whitelist`, ui);
        ui.write(`You want to remove ${newWhitelistedAddress} from whitelist?\n`);
        retry = !(await promptBool('Is it ok?(y/n)', ['y', 'n'], ui));
    } while (retry);

    ui.write(`Removing ${newWhitelistedAddress} from whitelist\n`);
    const mintFees = toNano('0.05');
    const forwardAmount = toNano('0.1');
    const totalTonAmount = forwardAmount + mintFees;
    const getLastSeqno = (await provider.api().getLastBlock()).last.seqno;
    const curState = (await provider.api().getAccount(getLastSeqno, minterContract.address)).account;
    const queryId = randomQueryId();

    if (curState.last === null) throw "Last transaction can't be null on deployed contract";
    const res = await minterContract.sendRemoveFromWhitelist(provider.sender(), {
        removedAddress: newWhitelistedAddress,
        queryId,
    });
    const gotTrans = await waitForTransaction(provider, minterContract.address, curState.last.lt, 30);
    if (gotTrans) {
        const whitelist = await minterContract.get_whitelist();
        if (!whitelist.toString().includes(newWhitelistedAddress.toString())) {
            let whitelistAddresses: string = '';
            for (const address of whitelist) {
                whitelistAddresses += `${address.toString()}\n`;
            }
            ui.write(
                'Address succesfully removed from whitelist!\nCurrent whitelist dictionary:\n' + whitelistAddresses,
            );
        } else {
            ui.write('Remove from whitelist failed!');
        }
    } else {
        failedTransMessage(ui);
    }
};
const checkBlacklistAction = async (provider: NetworkProvider, ui: UIProvider) => {
    let retry: boolean;
    // let forwardAmount: string;
    let blacklistChecked: Address;

    do {
        retry = false;

        blacklistChecked = await promptAddress(`Please specify address to remove from whitelist`, ui);
        ui.write(`You want to check ${blacklistChecked} in blacklist?\n`);
        retry = !(await promptBool('Is it ok?(y/n)', ['y', 'n'], ui));
    } while (retry);

    ui.write(`Checking ${blacklistChecked} in blacklist\n`);

    const getLastSeqno = (await provider.api().getLastBlock()).last.seqno;
    const curState = (await provider.api().getAccount(getLastSeqno, minterContract.address)).account;
    const queryId = randomQueryId();

    if (curState.last === null) throw "Last transaction can't be null on deployed contract";
    const res = await minterContract.sendCheckBlacklist(provider.sender(), {
        checkAddress: blacklistChecked,
        queryId,
    });
    const gotTrans = await waitForTransaction(provider, minterContract.address, curState.last.lt, 30);
    if (gotTrans) {
        if (true) {
            ui.write('Address succesfully removed from whitelist!\nCurrent whitelist dictionary:\n');
        } else {
            ui.write('Remove from whitelist failed!');
        }
    } else {
        failedTransMessage(ui);
    }
};
const infoWhitelistAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender = provider.sender();

    const whitelist = await minterContract.get_whitelist();
    if (whitelist.length) {
        let whitelistAddresses: string = '';
        for (const address of whitelist) {
            whitelistAddresses += `${address.toString()}\n`;
        }
        ui.write(`\nCurrent whitelist dictionary:\n${whitelistAddresses}\n`);
    } else {
        ui.write('\nWhitelist dictionary is empty!\n');
    }
};
const getBlacklistAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender = provider.sender();

    const blacklist = await minterContract.get_blacklisted_address();
    ui.write(`\nCurrent blacklist address:\n${blacklist.blacklistAddress}\n`);
};
const addToBlacklistAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender = provider.sender();
    let retry: boolean;
    let mintAddress: Address;
    let mintAmount: string;
    let newBlacklistedAddress: Address;

    // let forwardAmount: string;

    do {
        retry = false;
        const blacklistedBefore = await minterContract.get_blacklisted_address();
        const zeroAddress = Address.parseRaw('0:0000000000000000000000000000000000000000000000000000000000000000');
        const fallbackAddr = blacklistedBefore.blacklistAddress;

        newBlacklistedAddress = await promptAddress(`Please specify address to add to blacklist`, ui, fallbackAddr);
        // mintAmount = await promptAmount('Please provide mint amount:', ui);
        ui.write(`You want to add ${newBlacklistedAddress} to blacklist?\n`);
        retry = !(await promptBool('Is it ok?(y/n)', ['y', 'n'], ui));
    } while (retry);

    ui.write(`Adding ${newBlacklistedAddress} to blacklist\n`);
    const mintFees = toNano('0.05');
    const forwardAmount = toNano('0.1');
    const totalTonAmount = forwardAmount + mintFees;
    const getLastSeqno = (await provider.api().getLastBlock()).last.seqno;
    const curState = (await provider.api().getAccount(getLastSeqno, minterContract.address)).account;

    console.log(newBlacklistedAddress.toRawString());
    console.log(newBlacklistedAddress.toString());
    if (curState.last === null) throw "Last transaction can't be null on deployed contract";
    // provider.provider(minterContract.address);
    const res = await minterContract.sendSetBlacklist(provider.sender(), newBlacklistedAddress);
    const gotTrans = await waitForTransaction(provider, minterContract.address, curState.last.lt, 30);
    if (gotTrans) {
        const blacklistedAfter = await minterContract.get_blacklisted_address();

        if (blacklistedAfter.blacklistAddress.equals(newBlacklistedAddress)) {
            ui.write(
                'Blacklisted succesfully updated!\nCurrent blacklisted address:' + blacklistedAfter.blacklistAddress,
            );
        } else {
            ui.write('Blacklisting failed!');
        }
    } else {
        failedTransMessage(ui);
    }
};

const randomQueryId = (): number => {
    // Генерируем 8 случайных байтов (64 бита)
    const randomBuffer = randomBytes(8);

    // Преобразуем байты в BigInt
    return Number(BigInt(`0x${randomBuffer.toString('hex')}`));
};

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const hasSender = sender.address !== undefined;
    const api = provider.api();
    const minterCode = await compile('JettonMinterDiscoverable');
    let done = false;
    // let retry: boolean;
    // let minterAddress: Address;

    // do {
    //     retry = false;
    //     // minterAddress = await promptAddress('Please enter minter address:', ui);
    //     minterAddress = Address.parse('EQBFXTh4gF3VVFGs-4NnxeX72s8B9QWCCFNxWlIC9Q3o-Eu0');
    //     const getLastSeqno = (await api.getLastBlock()).last.seqno;
    //     const contractState = (await api.getAccount(getLastSeqno, minterAddress)).account.state;
    //     if (contractState.type !== 'active' || contractState.code == null) {
    //         retry = true;
    //         ui.write('This contract is not active!\nPlease use another address, or deploy it first');
    //     } else {
    //         console.log(contractState.code);
    //         const stateCode = Cell.fromBase64(contractState.code);
    //         if (!stateCode.equals(minterCode)) {
    //             ui.write('Contract code differs from the current contract version!\n');
    //             const resp = await ui.choose('Use address anyway', ['Yes', 'No'], (c) => c);
    //             retry = resp == 'No';
    //         }
    //     }
    // } while (retry);
    const minterAddress: Address = Address.parse('EQD2VUwpv2TY-V7FEXXyXDRKnmSOrVfuUCNiFuPvU1wVknhH');

    minterContract = provider.open(JettonMinter.createFromAddress(minterAddress));
    userWallet = async (address: Address) =>
        provider.open(JettonWallet.createFromAddress(await minterContract.getWalletAddress(address)));
    walletContract = provider.open(
        JettonWallet.createFromAddress(await minterContract.getWalletAddress(sender.address!)),
    );
    // console.log('walletContract.address', walletContract.address);
    // console.log('userWallet(sender.address!).address', (await userWallet(sender.address!)).address);
    const isAdmin = hasSender ? (await minterContract.getAdminAddress()).equals(sender.address) : true;
    let actionList: string[];
    if (isAdmin) {
        actionList = [...adminActions, ...userActions];
        ui.write('Current wallet is minter admin!\n');
    } else {
        actionList = userActions;
        ui.write('Current wallet is not admin!\nAvaliable actions restricted\n');
    }

    do {
        const action = await ui.choose('Pick action:', actionList, (c) => c);
        switch (action) {
            case 'Set blacklist address':
                await addToBlacklistAction(provider, ui);
                break;
            case 'Add address to whitelist':
                await addToWhitelistAction(provider, ui);
                break;
            case 'Remove address from whitelist':
                await removeFromWhitelistAction(provider, ui);
                break;
            case 'Mint':
                await mintAction(provider, ui);
                break;
            case 'Transfer':
                await transferAction(provider, ui);
                break;
            case 'Get blacklist address':
                await getBlacklistAction(provider, ui);
                break;
            // case 'Check blacklist address':
            //     await checkBlacklistAction(provider, ui);
            //     break;
            case 'Get whitelist address(es)':
                await infoWhitelistAction(provider, ui);
                break;
            case 'Jetton info':
                await infoAction(provider, ui);
                break;
            case 'Withdraw TON from Jetton Minter (Jetton Master)':
                await withdrawAction(provider, ui);
                break;
            case 'Quit':
                done = true;
                break;
        }
    } while (!done);
}
