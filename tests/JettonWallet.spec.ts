import { TonClient4 } from '@ton/ton';

import { getHttpV4Endpoint } from '@orbs-network/ton-access';

import {
    Blockchain,
    SandboxContract,
    TreasuryContract,
    internal,
    BlockchainSnapshot,
    RemoteBlockchainStorage,
    wrapTonClient4ForRemote,
} from '@ton/sandbox';
import jettonMinterContent from '../data/jetton-metadata.json';

import { Cell, toNano, beginCell, Address, Slice, Dictionary } from '@ton/core';
import { JettonWallet } from '../wrappers/JettonWallet';
import {
    JettonMinter,
    jettonOnChainContentToCell,
    jettonOffChainContentToCell,
} from '../wrappers/JettonMinterDiscoverable';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    randomAddress,
    getRandomTon,
    differentAddress,
    getRandomInt,
    testJettonTransfer,
    testJettonInternalTransfer,
    testJettonNotification,
    testJettonBurnNotification,
} from './utils';
import { Op, Errors } from '../wrappers/JettonConstants';

/*
   These tests check compliance with the TEP-74 and TEP-89,
   but also checks some implementation details.
   If you want to keep only TEP-74 and TEP-89 compliance tests,
   you need to remove/modify the following tests:
     mint tests (since minting is not covered by standard)
     exit_codes
     prove pathway
*/

//jetton params

let fwd_fee = 1804014n,
    gas_consumption = 15000000n,
    min_tons_for_storage = 10000000n;
//let fwd_fee = 1804014n, gas_consumption = 14000000n, min_tons_for_storage = 10000000n;

describe('JettonWallet', () => {
    let jwallet_code = new Cell();
    let minter_code = new Cell();
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let notDeployer: SandboxContract<TreasuryContract>;
    let jettonMinter: SandboxContract<JettonMinter>;
    let userWallet: (address: Address) => Promise<SandboxContract<JettonWallet>>;
    let defaultContent: Cell;
    let blacklisted: Address;
    let whitelist: Cell;

    // by default was beforeAll
    beforeEach(async () => {
        jwallet_code = await compile('JettonWallet');
        minter_code = await compile('JettonMinterDiscoverable');
        blockchain = await Blockchain.create();
        // blockchain = await Blockchain.create({
        //     storage: new RemoteBlockchainStorage(
        //         wrapTonClient4ForRemote(
        //             new TonClient4({
        //                 endpoint: await getHttpV4Endpoint({
        //                     network: 'testnet',
        //                 }),
        //             }),
        //         ),
        //     ),
        // });
        blockchain.verbosity = {
            print: true,
            blockchainLogs: false,
            vmLogs: 'none',
            debugLogs: true,
        };

        deployer = await blockchain.treasury('deployer');
        notDeployer = await blockchain.treasury('notDeployer');
        defaultContent = jettonOffChainContentToCell({
            type: 1,
            uri: 'https://raw.githubusercontent.com/veebull/web3-metadata/main/jetton-metadata-1.json',
        });
        defaultContent = jettonOnChainContentToCell(jettonMinterContent);
        // export type Verbosity = 'none' | 'vm_logs' | 'vm_logs_location' | 'vm_logs_gas' | 'vm_logs_full' | 'vm_logs_verbose';

        blacklisted = Address.parseRaw('0:0000000000000000000000000000000000000000000000000000000000000000');
        const whitelistDict = Dictionary.empty();
        // Ячейка с пустым словарем
        whitelist = beginCell().storeDict(whitelistDict).endCell();
        jettonMinter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: deployer.address,
                    content: defaultContent,
                    wallet_code: jwallet_code,
                    blacklisted,
                    whitelist,
                },
                minter_code,
            ),
        );
        userWallet = async (address: Address) =>
            blockchain.openContract(JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(address)));
        const deployResult = await jettonMinter.sendDeploy(deployer.getSender(), toNano('0.15'));

        // await jettonMinter.sendDeploy(deployer.getSender(), toNano('100'));
    });

    // implementation detail
    it('should deploy', async () => {
        const deployResult = await jettonMinter.sendDeploy(deployer.getSender(), toNano('100'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonMinter.address,
            deploy: true,
            success: true,
        });
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        console.log(initialTotalSupply);
        let content = await jettonMinter.getContent();
        console.log(content);
    });

    it('minter admin can add address to blacklist', async () => {
        const blacklistedBefore = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedBefore', blacklistedBefore.blacklistAddress);
        const newBlacklistedAddress = (await blockchain.treasury('blacklisted')).address;

        const blacklistResult = await jettonMinter.sendSetBlacklist(deployer.getSender(), newBlacklistedAddress);

        const blacklistedAfter = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedAfter', blacklistedAfter.blacklistAddress);
        expect(blacklistResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        expect(newBlacklistedAddress).toEqualAddress(blacklistedAfter.blacklistAddress);
    });

    it('not a minter admin can not add address to blacklist', async () => {
        const blacklistedBefore = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedBefore', blacklistedBefore.blacklistAddress);

        const newBlacklistedAddress = (await blockchain.treasury('blacklisted')).address;
        let changeBlacklisted = await jettonMinter.sendSetBlacklist(notDeployer.getSender(), newBlacklistedAddress);

        expect(changeBlacklisted.transactions).toHaveTransaction({
            from: notDeployer.address,
            on: jettonMinter.address,
            aborted: true,
            exitCode: Errors.not_admin, // error::unauthorized_change_admin_request
        });

        const blacklistedAfter = await jettonMinter.get_blacklisted_address();
        expect(blacklistedBefore.blacklistAddress).toEqualAddress(blacklistedAfter.blacklistAddress);
    });

    it('only minter admin should be able to add address to whitelist', async () => {
        const whitelistBefore = await jettonMinter.get_whitelist();
        expect(whitelistBefore).toHaveLength(0);

        const newWhitelistedAddress = (await blockchain.treasury('whitelisted')).address;

        let changeWhitelist = await jettonMinter.sendAddToWhitelist(deployer.getSender(), {
            whitelistedAddress: newWhitelistedAddress,
        });

        expect(changeWhitelist.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        const whitelistAfter = await jettonMinter.get_whitelist();
        expect(whitelistAfter).toHaveLength(1);
    });
    it('not a minter admin should be able not to add address to whitelist', async () => {
        const whitelistBefore = await jettonMinter.get_whitelist();
        expect(whitelistBefore).toHaveLength(0);

        const newWhitelistedAddress = (await blockchain.treasury('whitelisted')).address;

        let changeWhitelist = await jettonMinter.sendAddToWhitelist(notDeployer.getSender(), {
            whitelistedAddress: newWhitelistedAddress,
        });

        expect(changeWhitelist.transactions).toHaveTransaction({
            from: notDeployer.address,
            on: jettonMinter.address,
            aborted: true,
            exitCode: Errors.not_admin,
        });
        const whitelistAfter = await jettonMinter.get_whitelist();
        expect(whitelistAfter).toHaveLength(0);
    });

    it('any should not transfer jettons to blacklisted address', async () => {
        //////////////////////////////////////
        // Step 1. Add address to blacklist //
        //////////////////////////////////////
        const blacklistedBefore = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedBefore', blacklistedBefore.blacklistAddress);
        // const newBlacklistedAddress = (await blockchain.treasury('blacklisted')).address;
        const newBlacklistedAddress = Address.parse('0QBaVOzD66Nbc6hvptvWZSy0fZjkz239kYVA3HlEYMaTj9Mv');
        const newBlacklistedJettonWallet = await userWallet(newBlacklistedAddress);
        const blacklistResult = await jettonMinter.sendSetBlacklist(deployer.getSender(), newBlacklistedAddress);

        const blacklistedAfter = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedAfter', blacklistedAfter.blacklistAddress);
        expect(blacklistResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        expect(newBlacklistedAddress).toEqualAddress(blacklistedAfter.blacklistAddress);

        //////////////////////////////////////////
        // Step2. Add jettons to a minter admin //
        //////////////////////////////////////////

        let initialTotalSupplyBefore = await jettonMinter.getTotalSupply(); // 0n
        const deployerJettonWallet = await userWallet(deployer.address); // {JettonWallet{address: EQ...5ZS},init:undefined}
        const initialJettonBalance = toNano('1000');
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: deployer.address, // к кому отправить монеты
            jettonAmount: initialJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });

        let initialTotalSupplyAfterMint = await jettonMinter.getTotalSupply(); // 1000000000000n
        console.log('initialTotalSupplyAfterMint', initialTotalSupplyAfterMint);

        expect(mintResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployerJettonWallet.address,
            deploy: true,
        });

        // expect(mintResult.transactions).toHaveTransaction({
        //     // excesses
        //     from: deployerJettonWallet.address,
        //     to: jettonMinter.address,
        // });
        let deployerInitialJettonBalance = await deployerJettonWallet.getJettonBalance(); //1000e9n
        expect(deployerInitialJettonBalance).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupplyBefore + initialJettonBalance);

        ///////////////////////////////////////////////////////////////////
        // Step 3. Transfer jettons from deployer to blacklisted address //
        ///////////////////////////////////////////////////////////////////
        // (newBlacklistedAddress)

        // get jettonMinterBalance
        const jettonMinterBalanceBefore = (await jettonMinter.getBalance()).num;
        console.log('jettonMinterBalanceBefore', (await jettonMinter.getBalance()).pretty);

        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let notDeployerInitialJettonBalance = await notDeployerJettonWallet.getJettonBalance(); // 0n
        console.log('initialJettonBalance', initialJettonBalance);
        console.log('notDeployerInitialJettonBalance', notDeployerInitialJettonBalance);
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0'); // 0.1
        const msgValue = toNano('0.05'); // 0.3
        console.log(await deployerJettonWallet.getJettonBalance());
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            msgValue, //tons
            sentAmount,
            newBlacklistedAddress,
            notDeployer.address,
            // deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );
        for (let index = 0; index < 30; index++) {
            await deployerJettonWallet.sendTransfer(
                deployer.getSender(),
                msgValue, //tons
                sentAmount,
                newBlacklistedAddress,
                notDeployer.address,
                // deployer.address,
                beginCell().endCell(),
                forwardAmount,
                beginCell().endCell(),
            );
        }
        // expect(sendResult.transactions).toHaveTransaction({
        //     // call op::transfer
        //     from: deployerJettonWallet.address,
        //     to: jettonMinter.address,
        //     // value: msgValue,
        //     op: Op.transfer_notification,
        //     success: true,
        //     exitCode: 0,
        // });

        console.log(await deployerJettonWallet.getJettonBalance());
        console.log('newBlacklistedAddress', newBlacklistedAddress); // EQCUtK9_pThAmq6dbML1NfacMpX07AmohV2lLsAXtLXn3BQ4
        console.log('notDeployer.address', notDeployer.address); //EQAnmQEaaVYF3MxQ2Sciro_1rnvLaog62y17-J6_AbCz_nUD
        console.log('deployer.address', deployer.address); //EQBGhqLAZseEqRXz4ByFPTGV7SVMlI4hrbs-Sps_Xzx01x8G
        console.log('jettonMinter.address', jettonMinter.address); //EQAgZ2BT4tOLIka-d8q0qXiiHGpI7frgxGZrurQn_K8r9JMm
        console.log('notDeployerJettonWallet.address', notDeployerJettonWallet.address); // EQDLrE1CyibjrL2gsO21iu4v38khkCfZzzhaHi3qEIHxyaPL
        console.log('deployerJettonWallet.address', deployerJettonWallet.address); //EQCk6VTDx0tNLpWZ124VFvZBrTtjGPccNDH7WT5RBjnseU-J
        console.log('newBlacklistedWalletAddress.address', (await userWallet(newBlacklistedAddress)).address); //EQCk6VTDx0tNLpWZ124VFvZBrTtjGPccNDH7WT5RBjnseU-J
        // expect(sendResult.transactions).toHaveTransaction({
        //     //internal_transfer
        //     from: deployerJettonWallet.address,
        //     to: newBlacklistedJettonWallet.address,
        //     deploy: true,
        //     success: true,
        //     op: Op.internal_transfer,
        //     exitCode: 0,
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // check_bwlist
        //     from: deployerJettonWallet.address,
        //     to: jettonMinter.address,
        //     success: true,
        //     op: Op.check_bwlist,
        //     exitCode: 0,
        // });

        // check totalSupply
        const initialTotalSupplyAfterFail = await jettonMinter.getTotalSupply();
        expect(initialTotalSupplyAfterMint).toEqual(initialTotalSupplyAfterFail);

        // check jettons balances, must be not change
        const deployerJettonBalanceFinish = await deployerJettonWallet.getJettonBalance();
        console.log('deployerJettonBalanceFinish', deployerJettonBalanceFinish); // 83714924813975681n
        console.log('newBlacklistedJettonWalletBalance', await newBlacklistedJettonWallet.getJettonBalance()); // 83714924813975681n
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance); //83714924813975681n error
        expect(await newBlacklistedJettonWallet.getJettonBalance()).toEqual(0n);

        // check jettonMinter contract balance, must be not less than was
        const jettonMinterBalanceAfter = (await jettonMinter.getBalance()).num;

        console.log('jettonMinterBalanceAfter', (await jettonMinter.getBalance()).pretty);
        expect(jettonMinterBalanceAfter).toBeGreaterThan(jettonMinterBalanceBefore);
    });
    it('bounceable and non-bonceable addresses are equals', async () => {
        /////////////////////////////////////////////////
        // Step 1. Add non-bounceable address to blacklist //
        /////////////////////////////////////////////////
        const nonBounceableAddress = Address.parse('0QBaVOzD66Nbc6hvptvWZSy0fZjkz239kYVA3HlEYMaTj9Mv');
        await jettonMinter.sendSetBlacklist(deployer.getSender(), nonBounceableAddress);
        const nonBounceableBlacklistedAddress = await jettonMinter.get_blacklisted_address();
        console.log('nonBounceableBlacklistedAddress', nonBounceableBlacklistedAddress);

        /////////////////////////////////////////////////
        // Step 2. Add bounceable address to blacklist //
        /////////////////////////////////////////////////
        const bounceableAddress = Address.parse('kQBaVOzD66Nbc6hvptvWZSy0fZjkz239kYVA3HlEYMaTj47q');
        await jettonMinter.sendSetBlacklist(deployer.getSender(), bounceableAddress);
        const bounceableBlacklistedAddress = await jettonMinter.get_blacklisted_address();
        console.log('bounceableBlacklistedAddress', bounceableBlacklistedAddress);

        expect(bounceableBlacklistedAddress.blacklistAddress).toEqualAddress(
            nonBounceableBlacklistedAddress.blacklistAddress,
        );
    });
    it('should transfer to whitelist address even it blacklisted', async () => {
        //////////////////////////////////////
        // Step 1. Add address to blacklist //
        //////////////////////////////////////
        const blacklistedBefore = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedBefore', blacklistedBefore.blacklistAddress);
        const newWhiteBlacklistedAddress = (await blockchain.treasury('whiteblacklisted')).address;

        const blacklistResult = await jettonMinter.sendSetBlacklist(deployer.getSender(), newWhiteBlacklistedAddress);

        const blacklistedAfter = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedAfter', blacklistedAfter.blacklistAddress);
        expect(blacklistResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        expect(newWhiteBlacklistedAddress).toEqualAddress(blacklistedAfter.blacklistAddress);

        /////////////////////////////////////////////////
        // Step2. Add blacklisted address to whitelist //
        /////////////////////////////////////////////////
        const whitelistBefore = await jettonMinter.get_whitelist();
        expect(whitelistBefore).toHaveLength(0);

        let changeWhitelist = await jettonMinter.sendAddToWhitelist(deployer.getSender(), {
            whitelistedAddress: newWhiteBlacklistedAddress,
        });

        expect(changeWhitelist.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        const whitelistAfter = await jettonMinter.get_whitelist();
        expect(whitelistAfter).toHaveLength(1);

        //////////////////////////////////////////
        // Step3. Add jettons to a minter admin //
        //////////////////////////////////////////

        let initialTotalSupply = await jettonMinter.getTotalSupply(); // 0n
        const deployerJettonWallet = await userWallet(deployer.address); // {JettonWallet{address: EQ...5ZS},init:undefined}
        const initialJettonBalance = toNano('1000');
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: deployer.address, // к кому отправить монеты
            jettonAmount: initialJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });
        const initialTotalSupplyAfterMint = await jettonMinter.getTotalSupply();

        expect(mintResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployerJettonWallet.address,
            deploy: true,
        });

        expect(mintResult.transactions).toHaveTransaction({
            // excesses
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + initialJettonBalance);

        ///////////////////////////////////////////////
        // Step 4. Transfer jettons from deployer to //
        ///////////////////////////////////////////////

        //whitelisted-blacklisted address (newBWAddress)

        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        console.log('initialJettonBalance', initialJettonBalance);
        console.log('initialJettonBalance2', initialJettonBalance2);
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            newWhiteBlacklistedAddress,
            notDeployer.address,
            // deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );

        const whiteBlacklistedJettonWalletAddress = (await userWallet(newWhiteBlacklistedAddress)).address;

        // check addresses in trace (@NEED labeled addresses)
        console.log('newWhiteBlacklistedAddress', newWhiteBlacklistedAddress);
        console.log('notDeployer.address', notDeployer.address);
        console.log('deployer.address', deployer.address);
        console.log('jettonMinter.address', jettonMinter.address);
        console.log('notDeployerJettonWallet.address', notDeployerJettonWallet.address);
        console.log('deployerJettonWallet.address', deployerJettonWallet.address);
        console.log('whiteBlacklistedJettonWalletAddress', whiteBlacklistedJettonWalletAddress);

        // expect(sendResult.transactions).toHaveTransaction({
        //     // deployer address call op::transfer to deployerJettonWallet
        //     from: deployer.address,
        //     to: deployerJettonWallet.address,
        //     aborted: false,
        //     op: Op.transfer,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // deployerJettonWallet call jettonMinter for op::check_bwlist
        //     // can we transfer to newWhiteBlacklistedAddress
        //     from: deployerJettonWallet.address,
        //     to: jettonMinter.address,
        //     aborted: false,
        //     op: Op.check_bwlist,
        //     // value: forwardAmount,1130915172
        // });

        // expect(sendResult.transactions).toHaveTransaction({
        //     // if success transfer to checked address
        //     from: jettonMinter.address,
        //     to: whiteBlacklistedJettonWalletAddress,
        //     success: true,
        //     op: Op.internal_transfer,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // if success transfer to checked address
        //     from: jettonMinter.address,
        //     to: deployerJettonWallet.address,
        //     success: true,
        //     op: Op.decrease_balance,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     //excesses
        //     from: whiteBlacklistedJettonWalletAddress,
        //     to: newWhiteBlacklistedAddress,
        //     success: true,
        //     op: Op.transfer_notification,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     //excesses
        //     from: whiteBlacklistedJettonWalletAddress,
        //     to: deployer.address,
        //     success: true,
        //     op: Op.excesses,
        //     // value: forwardAmount,1130915172
        // });

        console.log('await deployerJettonWallet.getJettonBalance()', await deployerJettonWallet.getJettonBalance());

        // check balances of initiator of transfer
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);

        const whiteBlackJettonWalletAddress = await userWallet(newWhiteBlacklistedAddress);
        console.log(
            'await whiteBlackJettonWalletAddress.getJettonBalance()',
            await whiteBlackJettonWalletAddress.getJettonBalance(),
        );

        // check incoming balamce of checked address
        expect(await whiteBlackJettonWalletAddress.getJettonBalance()).toEqual(sentAmount);

        // check total supply, must be as the start
        const initialTotalSupplyAfterFail = await jettonMinter.getTotalSupply();
        expect(initialTotalSupplyAfterMint).toEqual(initialTotalSupplyAfterFail);
    });
    it('should transfer to address in whitelist NOT in blacklist', async () => {
        /////////////////////////////////////////////////
        // Step 1. Add blacklisted address to whitelist //
        /////////////////////////////////////////////////
        const newWhitedAddress = (await blockchain.treasury('whitelisted')).address;

        const whitelistBefore = await jettonMinter.get_whitelist();
        expect(whitelistBefore).toHaveLength(0);

        let changeWhitelist = await jettonMinter.sendAddToWhitelist(deployer.getSender(), {
            whitelistedAddress: newWhitedAddress,
        });

        expect(changeWhitelist.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        const whitelistAfter = await jettonMinter.get_whitelist();
        expect(whitelistAfter).toHaveLength(1);

        //////////////////////////////////////////
        // Step 2. Add jettons to a minter admin //
        //////////////////////////////////////////

        let initialTotalSupply = await jettonMinter.getTotalSupply(); // 0n
        const deployerJettonWallet = await userWallet(deployer.address); // {JettonWallet{address: EQ...5ZS},init:undefined}
        const initialJettonBalance = toNano('1000');
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: deployer.address, // к кому отправить монеты
            jettonAmount: initialJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });
        const initialTotalSupplyAfterMint = await jettonMinter.getTotalSupply();

        expect(mintResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployerJettonWallet.address,
            deploy: true,
        });

        expect(mintResult.transactions).toHaveTransaction({
            // excesses
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + initialJettonBalance);

        ///////////////////////////////////////////////
        // Step 3. Transfer jettons from deployer to //
        ///////////////////////////////////////////////

        //whitelisted-blacklisted address (newBWAddress)

        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        console.log('initialJettonBalance', initialJettonBalance);
        console.log('initialJettonBalance2', initialJettonBalance2);
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            newWhitedAddress,
            notDeployer.address,
            // deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );

        const whiteBlacklistedJettonWalletAddress = (await userWallet(newWhitedAddress)).address;

        // check addresses in trace (@NEED labeled addresses)
        console.log('newWhitedAddress', newWhitedAddress);
        console.log('notDeployer.address', notDeployer.address);
        console.log('deployer.address', deployer.address);
        console.log('jettonMinter.address', jettonMinter.address);
        console.log('notDeployerJettonWallet.address', notDeployerJettonWallet.address);
        console.log('deployerJettonWallet.address', deployerJettonWallet.address);
        console.log('whiteBlacklistedJettonWalletAddress', whiteBlacklistedJettonWalletAddress);

        // expect(sendResult.transactions).toHaveTransaction({
        //     // go to jettonMinter to check address
        //     from: deployerJettonWallet.address,
        //     to: jettonMinter.address,
        //     success: true,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // jetton minter call op::decrease_balance to sender_address
        //     from: jettonMinter.address,
        //     to: deployerJettonWallet.address,
        //     aborted: false,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // if success transfer to checked address
        //     from: jettonMinter.address,
        //     to: whiteBlacklistedJettonWalletAddress,
        //     success: true,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     //excesses
        //     from: whiteBlacklistedJettonWalletAddress,
        //     to: newWhitedAddress,
        //     success: true,
        //     // value: forwardAmount,1130915172
        // });

        console.log('await deployerJettonWallet.getJettonBalance()', await deployerJettonWallet.getJettonBalance());

        // check balances of initiator of transfer
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);

        const whiteBlackJettonWalletAddress = await userWallet(newWhitedAddress);
        console.log(
            'await whiteBlackJettonWalletAddress.getJettonBalance()',
            await whiteBlackJettonWalletAddress.getJettonBalance(),
        );

        // check incoming balamce of checked address
        expect(await whiteBlackJettonWalletAddress.getJettonBalance()).toEqual(sentAmount);

        // check total supply, must be as the start
        const initialTotalSupplyAfterFail = await jettonMinter.getTotalSupply();
        expect(initialTotalSupplyAfterMint).toEqual(initialTotalSupplyAfterFail);
    });
    it('should transfer to any address if whitelisted empty and NOT blacklisted', async () => {
        // CONSTANTS
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        const deployerJettonWallet = await userWallet(deployer.address); // {JettonWallet{address: EQ...5ZS},init:undefined}

        // check addresses in trace (@NEED labeled addresses)
        console.log('notDeployer.address', notDeployer.address);
        console.log('deployer.address', deployer.address);
        console.log('jettonMinter.address', jettonMinter.address);
        console.log('notDeployerJettonWallet.address', notDeployerJettonWallet.address);
        console.log('deployerJettonWallet.address', deployerJettonWallet.address);

        //////////////////////////////////////////
        // Step 1. Add jettons to a minter admin //
        //////////////////////////////////////////

        let initialTotalSupply = await jettonMinter.getTotalSupply(); // 0n

        const initialJettonBalance = toNano('1000');
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: deployer.address, // response address
            toAddress: deployer.address, // к кому отправить монеты
            jettonAmount: initialJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });
        const initialTotalSupplyAfterMint = await jettonMinter.getTotalSupply();

        // expect(mintResult.transactions).toHaveTransaction({
        //     // from deployer init mint on jettonMinter
        //     from: deployer.address,
        //     to: jettonMinter.address,
        //     success: true,
        //     op: Op.mint,
        // });
        // expect(mintResult.transactions).toHaveTransaction({
        //     // from jettonMinter init internal_transfer on deployerJettonWallet
        //     from: jettonMinter.address, //jetton
        //     to: deployerJettonWallet.address,
        //     success: true,
        //     op: Op.internal_transfer,
        // });

        // expect(mintResult.transactions).toHaveTransaction({
        //     // excesses from deployerJettonWallet to deployerWallet
        //     from: deployerJettonWallet.address,
        //     to: deployer.address,
        //     op: Op.excesses,
        // });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + initialJettonBalance);

        ///////////////////////////////////////////////
        // Step 2. Transfer jettons from deployer to //
        ///////////////////////////////////////////////

        //whitelisted-blacklisted address (newBWAddress)

        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        console.log('initialJettonBalance', initialJettonBalance);
        console.log('initialJettonBalance2', initialJettonBalance2);

        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.000000001');
        const msgValue = toNano('0.05');
        const transferTimes = 5;

        for (let index = 0; index < transferTimes; index++) {
            const sendResult = await deployerJettonWallet.sendTransfer(
                deployer.getSender(),
                msgValue, //tons
                sentAmount,
                notDeployer.address, // to address
                deployer.address, // response address
                // deployer.address,
                beginCell().endCell(),
                forwardAmount,
                beginCell().endCell(),
            );
            // expect(sendResult.transactions).toHaveTransaction({
            //     // deployer call op::transfer on deployerJettonWallet
            //     from: deployer.address,
            //     to: deployerJettonWallet.address,
            //     success: true,
            //     op: Op.transfer,
            //     // value: forwardAmount,1130915172
            // });
        }

        // expect(sendResult.transactions).toHaveTransaction({
        //     // op::internal_transfer; increase balance of notDeployerJettonWallet
        //     from: deployerJettonWallet.address,
        //     to: notDeployerJettonWallet.address,
        //     deploy: true,
        //     success: true,
        //     op: Op.internal_transfer,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // op::check_bwlist
        //     from: deployerJettonWallet.address,
        //     to: jettonMinter.address,
        //     success: true,
        //     op: Op.check_bwlist,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // op::decrease_balance; decrease balance of deployerJettonWallet
        //     from: jettonMinter.address,
        //     to: deployerJettonWallet.address,
        //     success: true,
        //     op: Op.decrease_balance,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // op::transfer_notification
        //     from: notDeployerJettonWallet.address,
        //     to: notDeployer.address,
        //     success: true,
        //     op: Op.transfer_notification,
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // excesses
        //     from: notDeployerJettonWallet.address,
        //     to: deployer.address, // need to wallet_v4r1!
        //     aborted: false,
        //     success: true,
        //     op: Op.excesses,
        // });

        console.log('await deployerJettonWallet.getJettonBalance()', await deployerJettonWallet.getJettonBalance());

        // check balances of initiator of transfer
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(
            initialJettonBalance - sentAmount * BigInt(transferTimes),
        );

        // check incoming balamce of checked address
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(sentAmount * BigInt(transferTimes));

        // check total supply, must be as the start
        const initialTotalSupplyAfterFail = await jettonMinter.getTotalSupply();
        expect(initialTotalSupplyAfterMint).toEqual(initialTotalSupplyAfterFail);
        // const sendResult2 = await deployerJettonWallet.sendTransfer(
        //     deployer.getSender(),
        //     toNano('0.1'), //tons
        //     sentAmount,
        //     notDeployer.address, // to address
        //     deployer.address, // response address
        //     // deployer.address,
        //     beginCell().endCell(),
        //     forwardAmount,
        //     beginCell().endCell(),
        // );
        // expect(sendResult2.transactions).toHaveTransaction({
        //     // excesses
        //     from: notDeployerJettonWallet.address,
        //     to: deployer.address, // need to wallet_v4r1!
        //     aborted: false,
        //     success: true,
        //     op: Op.excesses,
        // });
    });

    it('should transfer to any address if it is not in whitelisted, whitelist is NOT empty and NOT in blacklisted', async () => {
        //////////////////////////////////////
        // Step 1. Add address to blacklist //
        //////////////////////////////////////
        const blacklistedBefore = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedBefore', blacklistedBefore.blacklistAddress);
        const newBlacklistedAddress = (await blockchain.treasury('blacklisted')).address;

        const blacklistResult = await jettonMinter.sendSetBlacklist(deployer.getSender(), newBlacklistedAddress);

        const blacklistedAfter = await jettonMinter.get_blacklisted_address();
        console.log('blacklistedAfter', blacklistedAfter.blacklistAddress);
        expect(blacklistResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        expect(newBlacklistedAddress).toEqualAddress(blacklistedAfter.blacklistAddress);

        //////////////////////////////////////////
        // Step 2. Add jettons to a minter admin //
        //////////////////////////////////////////

        let initialTotalSupply = await jettonMinter.getTotalSupply(); // 0n
        const deployerJettonWallet = await userWallet(deployer.address); // {JettonWallet{address: EQ...5ZS},init:undefined}
        const initialJettonBalance = toNano('1000');
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: deployer.address, // к кому отправить монеты
            jettonAmount: initialJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });
        const initialTotalSupplyAfterMint = await jettonMinter.getTotalSupply();

        expect(mintResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployerJettonWallet.address,
            deploy: true,
        });

        expect(mintResult.transactions).toHaveTransaction({
            // excesses
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + initialJettonBalance);

        ///////////////////////////////////////////////
        // Step 3. Transfer jettons from deployer to //
        ///////////////////////////////////////////////

        //whitelisted-blacklisted address (newBWAddress)

        const jettonMinterBalanceBefore = (await jettonMinter.getBalance()).num;
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        console.log('initialJettonBalance', initialJettonBalance);
        console.log('initialJettonBalance2', initialJettonBalance2);
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');

        const jettonWalletBalanceBefore = (await deployerJettonWallet.getBalance()).num;
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            notDeployer.address,
            notDeployer.address,
            // deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );

        // check addresses in trace (@NEED labeled addresses)
        console.log('notDeployer.address', notDeployer.address);
        console.log('deployer.address', deployer.address);
        console.log('jettonMinter.address', jettonMinter.address);
        console.log('notDeployerJettonWallet.address', notDeployerJettonWallet.address);
        console.log('deployerJettonWallet.address', deployerJettonWallet.address);

        // expect(sendResult.transactions).toHaveTransaction({
        //     // go to jettonMinter to check address
        //     from: deployerJettonWallet.address,
        //     to: jettonMinter.address,
        //     success: true,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // jetton minter call op::decrease_balance to sender_address
        //     from: jettonMinter.address,
        //     to: deployerJettonWallet.address,
        //     aborted: false,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     // if success transfer to checked address
        //     from: jettonMinter.address,
        //     to: notDeployerJettonWallet.address,
        //     success: true,
        //     // value: forwardAmount,1130915172
        // });
        // expect(sendResult.transactions).toHaveTransaction({
        //     //excesses
        //     from: notDeployerJettonWallet.address,
        //     to: notDeployer.address,
        //     success: true,
        //     // value: forwardAmount,1130915172
        // });

        console.log('await deployerJettonWallet.getJettonBalance()', await deployerJettonWallet.getJettonBalance());

        // check balances of initiator of transfer
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);

        // check incoming balamce of checked address
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(sentAmount);

        // check total supply, must be as the start
        const initialTotalSupplyAfterFail = await jettonMinter.getTotalSupply();
        expect(initialTotalSupplyAfterMint).toEqual(initialTotalSupplyAfterFail);

        // check jettonMinter contract balance, must be not less than was
        const jettonMinterBalanceAfter = (await jettonMinter.getBalance()).num;
        console.log('jettonMinterBalanceAfter', (await jettonMinter.getBalance()).pretty);
        expect(jettonMinterBalanceAfter).toBeGreaterThanOrEqual(jettonMinterBalanceBefore);

        // check TON balance of jetton wallet
        const jettonWalletBalanceAfter = (await deployerJettonWallet.getBalance()).num;
        expect(jettonWalletBalanceAfter).toBeGreaterThanOrEqual(jettonWalletBalanceBefore);
    });
    it('admin should withdraw from Jetton Minter to admin', async () => {
        /////////////////////////////////
        // Step 1. Send to Minter TON //
        ////////////////////////////////
        const jettonMinterTonBalanceBeforeSend = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceBeforeSend', jettonMinterTonBalanceBeforeSend);
        const sendTonResult = await deployer.send({ value: toNano(1), to: jettonMinter.address });
        const jettonMinterTonBalanceAfterSend = await jettonMinter.getBalance();
        expect(sendTonResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        console.log('jettonMinterTonBalanceAfterSend', jettonMinterTonBalanceAfterSend);
        // check balance of jetton minter after send ton from deployer
        expect(jettonMinterTonBalanceAfterSend.num).toBeGreaterThan(jettonMinterTonBalanceBeforeSend.num);

        ///////////////////////////////////////////
        // Step 2. Withdraw from Minter to admin //
        ///////////////////////////////////////////

        // get ton balances
        const jettonMinterTonBalanceBefore = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceBefore', jettonMinterTonBalanceBefore);
        const deployerTonBalanceBefore = await deployer.getBalance();
        console.log('deployerTonBalanceBefore', deployerTonBalanceBefore);

        // withdraw
        const amountToWithdraw = toNano(1);
        const withdrawResult = await jettonMinter.sendWithdrawTons(deployer.getSender(), amountToWithdraw);

        const jettonMinterTonBalanceAfter = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceAfter', jettonMinterTonBalanceAfter);
        const deployerTonBalanceAfter = await deployer.getBalance();
        console.log('deployerTonBalanceAfter', deployerTonBalanceAfter);

        expect(withdrawResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });

        // check balance of deployer
        expect(deployerTonBalanceAfter).toBeGreaterThan(deployerTonBalanceBefore);

        // check balance of jettonMinter
        expect(jettonMinterTonBalanceAfter.num).toBeLessThan(jettonMinterTonBalanceBefore.num);
    });
    it.only('not deployer should NOT withdraw from Jetton Minter to not admin', async () => {
        console.log('notDeployer.address', notDeployer.address);
        console.log('jettonMinter.address', jettonMinter.address);
        /////////////////////////////////
        // Step 1. Send to Minter TON //
        ////////////////////////////////
        const jettonMinterTonBalanceBeforeSend = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceBeforeSend', jettonMinterTonBalanceBeforeSend);
        const sendTonResult = await notDeployer.send({ value: toNano(1), to: jettonMinter.address });
        const jettonMinterTonBalanceAfterSend = await jettonMinter.getBalance();
        expect(sendTonResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            on: jettonMinter.address,
            success: true,
        });
        console.log('jettonMinterTonBalanceAfterSend', jettonMinterTonBalanceAfterSend);
        // check balance of jetton minter after send ton from deployer
        expect(jettonMinterTonBalanceAfterSend.num).toBeGreaterThan(jettonMinterTonBalanceBeforeSend.num);

        ///////////////////////////////////////////
        // Step 2. Withdraw from Minter to admin //
        ///////////////////////////////////////////

        // get ton balances
        const jettonMinterTonBalanceBefore = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceBefore', jettonMinterTonBalanceBefore);
        const notDeployerTonBalanceBefore = await notDeployer.getBalance();
        console.log('notDeployerTonBalanceBefore', notDeployerTonBalanceBefore);

        // withdraw
        const amountToWithdraw = toNano(1);
        const withdrawResult = await jettonMinter.sendWithdrawTons(notDeployer.getSender(), amountToWithdraw);

        const jettonMinterTonBalanceAfter = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceAfter', jettonMinterTonBalanceAfter);
        const notDeployerTonBalanceAfter = await notDeployer.getBalance();
        console.log('notDeployerTonBalanceAfter', notDeployerTonBalanceAfter);

        expect(withdrawResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            on: jettonMinter.address,
            success: false,
            exitCode: Errors.not_admin,
        });

        // check balance of deployer
        expect(notDeployerTonBalanceAfter).toBeLessThan(notDeployerTonBalanceBefore);

        // check balance of jettonMinter
        expect(jettonMinterTonBalanceAfter.num).toEqual(jettonMinterTonBalanceBefore.num);
    });
    it.only('should NOT withdraw greater than balance of Jetton Minter', async () => {
        console.log('deployer.address', deployer.address);
        console.log('jettonMinter.address', jettonMinter.address);
        /////////////////////////////////
        // Step 1. Send to Minter TON //
        ////////////////////////////////
        const jettonMinterTonBalanceBeforeSend = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceBeforeSend', jettonMinterTonBalanceBeforeSend);
        const sendTonResult = await deployer.send({ value: toNano(1), to: jettonMinter.address });
        const jettonMinterTonBalanceAfterSend = await jettonMinter.getBalance();
        expect(sendTonResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });
        console.log('jettonMinterTonBalanceAfterSend', jettonMinterTonBalanceAfterSend);
        // check balance of jetton minter after send ton from deployer
        expect(jettonMinterTonBalanceAfterSend.num).toBeGreaterThan(jettonMinterTonBalanceBeforeSend.num);

        ///////////////////////////////////////////
        // Step 2. Withdraw from Minter to admin //
        ///////////////////////////////////////////

        // get ton balances
        const jettonMinterTonBalanceBefore = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceBefore', jettonMinterTonBalanceBefore);
        const deployerTonBalanceBefore = await deployer.getBalance();
        console.log('deployerTonBalanceBefore', deployerTonBalanceBefore);

        // withdraw
        const amountToWithdraw = toNano(2);
        const withdrawResult = await jettonMinter.sendWithdrawTons(deployer.getSender(), amountToWithdraw);

        const jettonMinterTonBalanceAfter = await jettonMinter.getBalance();
        console.log('jettonMinterTonBalanceAfter', jettonMinterTonBalanceAfter);
        const deployerTonBalanceAfter = await deployer.getBalance();
        console.log('deployerTonBalanceAfter', deployerTonBalanceAfter);

        expect(withdrawResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: false,
            exitCode: Errors.insuficent_amount,
        });

        // check balance of deployer
        expect(deployerTonBalanceAfter).toBeLessThan(deployerTonBalanceBefore);

        // check balance of jettonMinter
        expect(jettonMinterTonBalanceAfter.num).toEqual(jettonMinterTonBalanceBefore.num);
    });
    it('no one can call op::decrease_balance forwardly in jetton-wallet', async () => {
        ///////////////////////////////////////////
        // Step 1. Add jettons to a minter admin //
        ///////////////////////////////////////////

        let initialTotalSupply = await jettonMinter.getTotalSupply(); // 0n
        const deployerJettonWallet = await userWallet(deployer.address); // {JettonWallet{address: EQ...5ZS},init:undefined}
        const initialJettonBalance = toNano('1000');
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: deployer.address, // к кому отправить монеты
            jettonAmount: initialJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });
        const initialTotalSupplyAfterMint = await jettonMinter.getTotalSupply();

        expect(mintResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployerJettonWallet.address,
            deploy: true,
        });

        expect(mintResult.transactions).toHaveTransaction({
            // excesses
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + initialJettonBalance);

        ///////////////////////////////////////////////////////
        // Step 2. Call op::decrease_balace of jetton wallet //
        // from not deployer address                         //
        ///////////////////////////////////////////////////////
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        const jettonAmount = toNano(0.5);
        const opDecreaseBalanceResult = await deployerJettonWallet.sendOpDecreaseBalance(notDeployer.getSender(), {
            fromAddress: jettonMinter.address,
            jettonAmount,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });

        expect(opDecreaseBalanceResult.transactions).toHaveTransaction({
            // go to jettonMinter to check address
            from: notDeployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_jetton_minter,
        });

        // check balances
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);

        ///////////////////////////////////////////////////////
        // Step 3. Call op::decrease_balace of jetton wallet //
        // from deployer address                             //
        ///////////////////////////////////////////////////////

        const opDecreaseBalanceResult2 = await deployerJettonWallet.sendOpDecreaseBalance(deployer.getSender(), {
            fromAddress: deployerJettonWallet.address,
            jettonAmount,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });
        expect(opDecreaseBalanceResult2.transactions).toHaveTransaction({
            // go to jettonMinter to check address
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_jetton_minter,
        });
    });

    // implementation detail
    it('minter admin should be able to mint jettons', async () => {
        // can mint from deployer
        let initialTotalSupply = await jettonMinter.getTotalSupply(); // 0n
        const deployerJettonWallet = await userWallet(deployer.address); // {JettonWallet{address: EQ...5ZS},init:undefined}

        let initialJettonBalance = toNano('1000.23');
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: deployer.address, // к кому отправить монеты
            jettonAmount: initialJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });

        expect(mintResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployerJettonWallet.address,
            deploy: true,
        });

        expect(mintResult.transactions).toHaveTransaction({
            // excesses
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
        });

        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + initialJettonBalance);
        initialTotalSupply += initialJettonBalance;
        // can mint from deployer again
        let additionalJettonBalance = toNano('2.31');
        await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: deployer.address, // к кому отправить монеты
            jettonAmount: additionalJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance + additionalJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + additionalJettonBalance);
        initialTotalSupply += additionalJettonBalance;
        // can mint to other address
        let otherJettonBalance = toNano('3.12');
        await jettonMinter.sendMint(deployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: notDeployer.address, // к кому отправить монеты
            jettonAmount: otherJettonBalance,
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(otherJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + otherJettonBalance);
        return;
    });

    // implementation detail
    it('not a minter admin should not be able to mint jettons', async () => {
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        console.log('initialTotalSupply123', initialTotalSupply);
        const notdeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance = await notdeployerJettonWallet.getJettonBalance();
        const unAuthMintResult = await jettonMinter.sendMint(notDeployer.getSender(), {
            fromAddress: jettonMinter.address, // response address
            toAddress: notDeployer.address, // к кому отправить монеты
            jettonAmount: toNano('777'),
            forward_ton_amount: toNano('0.05'),
            total_ton_amount: toNano('0.1'),
            queryId: 1,
        });

        expect(unAuthMintResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: jettonMinter.address,
            aborted: true,
            exitCode: Errors.not_admin, // error::unauthorized_mint_request
        });
        expect(await notdeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
    });

    // Implementation detail
    it('minter admin can change admin', async () => {
        const adminBefore = await jettonMinter.getAdminAddress();
        expect(adminBefore).toEqualAddress(deployer.address);
        let res = await jettonMinter.sendChangeAdmin(deployer.getSender(), notDeployer.address);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true,
        });

        const adminAfter = await jettonMinter.getAdminAddress();
        expect(adminAfter).toEqualAddress(notDeployer.address);
        await jettonMinter.sendChangeAdmin(notDeployer.getSender(), deployer.address);
        expect((await jettonMinter.getAdminAddress()).equals(deployer.address)).toBe(true);
    });
    it('not a minter admin can not change admin', async () => {
        const adminBefore = await jettonMinter.getAdminAddress();
        expect(adminBefore).toEqualAddress(deployer.address);
        let changeAdmin = await jettonMinter.sendChangeAdmin(notDeployer.getSender(), notDeployer.address);
        expect((await jettonMinter.getAdminAddress()).equals(deployer.address)).toBe(true);
        expect(changeAdmin.transactions).toHaveTransaction({
            from: notDeployer.address,
            on: jettonMinter.address,
            aborted: true,
            exitCode: Errors.not_admin, // error::unauthorized_change_admin_request
        });
    });

    it('minter admin can change content', async () => {
        // let newContent = jettonOffChainContentToCell({ type: 1, uri: 'https://totally_new_jetton.org/content.json' });
        let newContent = jettonOnChainContentToCell({
            name: 'New BW Jetton',
            description: 'New Sample BW of Jetton',
            symbol: 'NBWJ',
            decimals: 9,
            image: 'https://tonresear.ch/uploads/default/original/2X/2/21600939a9da67a2dd6c7dfac3f538cba1bec561.png',
        });
        expect((await jettonMinter.getContent()).equals(defaultContent)).toBe(true);
        let changeContent = await jettonMinter.sendChangeContent(deployer.getSender(), newContent);
        expect((await jettonMinter.getContent()).equals(newContent)).toBe(true);
        changeContent = await jettonMinter.sendChangeContent(deployer.getSender(), defaultContent);
        expect((await jettonMinter.getContent()).equals(defaultContent)).toBe(true);
    });
    it('not a minter admin can not change content', async () => {
        let newContent = beginCell().storeUint(1, 1).endCell();
        let changeContent = await jettonMinter.sendChangeContent(notDeployer.getSender(), newContent);
        expect((await jettonMinter.getContent()).equals(defaultContent)).toBe(true);
        expect(changeContent.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: jettonMinter.address,
            aborted: true,
            exitCode: Errors.not_admin, // error::unauthorized_change_content_request
        });
    });

    it('wallet owner should be able to send jettons', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            notDeployer.address,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );
        expect(sendResult.transactions).toHaveTransaction({
            //excesses
            from: notDeployerJettonWallet.address,
            to: deployer.address,
        });
        expect(sendResult.transactions).toHaveTransaction({
            //notification
            from: notDeployerJettonWallet.address,
            to: notDeployer.address,
            value: forwardAmount,
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2 + sentAmount);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
    });

    it('not wallet owner should not be able to send jettons', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = toNano('0.5');
        const sendResult = await deployerJettonWallet.sendTransfer(
            notDeployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            notDeployer.address,
            deployer.address,
            beginCell().endCell(),
            toNano('0.05'),
            beginCell().endCell(),
        );
        expect(sendResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_owner, //error::unauthorized_transfer
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
    });

    it('impossible to send too much jettons', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = initialJettonBalance + 1n;
        let forwardAmount = toNano('0.05');
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            notDeployer.address,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );
        expect(sendResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.balance_error, //error::not_enough_jettons
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2);
    });

    it.skip('malformed forward payload', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        const notDeployerJettonWallet = await userWallet(notDeployer.address);

        let sentAmount = toNano('0.5');
        let forwardAmount = getRandomTon(0.01, 0.05); // toNano('0.05');
        let forwardPayload = beginCell().storeUint(0x1234567890abcdefn, 128).endCell();
        let msgPayload = beginCell()
            .storeUint(0xf8a7ea5, 32)
            .storeUint(0, 64) // op, queryId
            .storeCoins(sentAmount)
            .storeAddress(notDeployer.address)
            .storeAddress(deployer.address)
            .storeMaybeRef(null)
            .storeCoins(toNano('0.05')) // No forward payload indication
            .endCell();
        const res = await blockchain.sendMessage(
            internal({
                from: deployer.address,
                to: deployerJettonWallet.address,
                body: msgPayload,
                value: toNano('0.2'),
            }),
        );

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: 708,
        });
    });

    it('correctly sends forward_payload', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        let forwardPayload = beginCell().storeUint(0x1234567890abcdefn, 128).endCell();
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            notDeployer.address,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            forwardPayload,
        );
        expect(sendResult.transactions).toHaveTransaction({
            //excesses
            from: notDeployerJettonWallet.address,
            to: deployer.address,
        });
        /*
        transfer_notification#7362d09c query_id:uint64 amount:(VarUInteger 16)
                                      sender:MsgAddress forward_payload:(Either Cell ^Cell)
                                      = InternalMsgBody;
        */
        expect(sendResult.transactions).toHaveTransaction({
            //notification
            from: notDeployerJettonWallet.address,
            to: notDeployer.address,
            value: forwardAmount,
            body: beginCell()
                .storeUint(Op.transfer_notification, 32)
                .storeUint(0, 64) //default queryId
                .storeCoins(sentAmount)
                .storeAddress(deployer.address)
                .storeUint(1, 1)
                .storeRef(forwardPayload)
                .endCell(),
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2 + sentAmount);
    });

    it('no forward_ton_amount - no forward', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = toNano('0.5');
        let forwardAmount = 0n;
        let forwardPayload = beginCell().storeUint(0x1234567890abcdefn, 128).endCell();
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            notDeployer.address,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            forwardPayload,
        );
        expect(sendResult.transactions).toHaveTransaction({
            //excesses
            from: notDeployerJettonWallet.address,
            to: deployer.address,
        });

        expect(sendResult.transactions).not.toHaveTransaction({
            //no notification
            from: notDeployerJettonWallet.address,
            to: notDeployer.address,
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2 + sentAmount);
    });

    it('check revert on not enough tons for forward', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        await deployer.send({ value: toNano('1'), bounce: false, to: deployerJettonWallet.address });
        let sentAmount = toNano('0.1');
        let forwardAmount = toNano('0.3');
        let forwardPayload = beginCell().storeUint(0x1234567890abcdefn, 128).endCell();
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            forwardAmount, // not enough tons, no tons for gas
            sentAmount,
            notDeployer.address,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            forwardPayload,
        );
        expect(sendResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_enough_ton, //error::not_enough_tons
        });
        // Make sure value bounced
        expect(sendResult.transactions).toHaveTransaction({
            from: deployerJettonWallet.address,
            on: deployer.address,
            inMessageBounced: true,
            success: true,
        });

        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
    });

    // implementation detail
    it('works with minimal ton amount', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const someAddress = Address.parse('EQD__________________________________________0vo');
        const someJettonWallet = await userWallet(someAddress);
        let initialJettonBalance2 = await someJettonWallet.getJettonBalance();
        await deployer.send({ value: toNano('1'), bounce: false, to: deployerJettonWallet.address });
        let forwardAmount = toNano('0.3');
        /*
                     forward_ton_amount +
                     fwd_count * fwd_fee +
                     (2 * gas_consumption + min_tons_for_storage));
        */
        let minimalFee = 2n * fwd_fee + 2n * gas_consumption + min_tons_for_storage;
        let sentAmount = forwardAmount + minimalFee; // not enough, need >
        let forwardPayload = beginCell().endCell();
        let tonBalance = (await blockchain.getContract(deployerJettonWallet.address)).balance;
        let tonBalance2 = (await blockchain.getContract(someJettonWallet.address)).balance;
        let sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            sentAmount,
            sentAmount,
            someAddress,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            forwardPayload,
        );
        expect(sendResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_enough_ton, //error::not_enough_tons
        });
        sentAmount += 1n; // now enough
        sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            sentAmount,
            sentAmount,
            someAddress,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            forwardPayload,
        );
        expect(sendResult.transactions).not.toHaveTransaction({
            //no excesses
            from: someJettonWallet.address,
            to: deployer.address,
        });
        /*
        transfer_notification#7362d09c query_id:uint64 amount:(VarUInteger 16)
                                      sender:MsgAddress forward_payload:(Either Cell ^Cell)
                                      = InternalMsgBody;
        */
        expect(sendResult.transactions).toHaveTransaction({
            //notification
            from: someJettonWallet.address,
            to: someAddress,
            value: forwardAmount,
            body: beginCell()
                .storeUint(Op.transfer_notification, 32)
                .storeUint(0, 64) //default queryId
                .storeCoins(sentAmount)
                .storeAddress(deployer.address)
                .storeUint(0, 1)
                .endCell(),
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);
        expect(await someJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2 + sentAmount);

        tonBalance = (await blockchain.getContract(deployerJettonWallet.address)).balance;
        expect((await blockchain.getContract(someJettonWallet.address)).balance).toBeGreaterThan(min_tons_for_storage);
    });

    // implementation detail
    it('wallet does not accept internal_transfer not from wallet', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        /*
  internal_transfer  query_id:uint64 amount:(VarUInteger 16) from:MsgAddress
                     response_address:MsgAddress
                     forward_ton_amount:(VarUInteger 16)
                     forward_payload:(Either Cell ^Cell)
                     = InternalMsgBody;
*/
        let internalTransfer = beginCell()
            .storeUint(0x178d4519, 32)
            .storeUint(0, 64) //default queryId
            .storeCoins(toNano('0.01'))
            .storeAddress(deployer.address)
            .storeAddress(deployer.address)
            .storeCoins(toNano('0.05'))
            .storeUint(0, 1)
            .endCell();
        const sendResult = await blockchain.sendMessage(
            internal({
                from: notDeployer.address,
                to: deployerJettonWallet.address,
                body: internalTransfer,
                value: toNano('0.3'),
            }),
        );
        expect(sendResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_valid_wallet, //error::unauthorized_incoming_transfer
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
    });

    it('wallet owner should be able to burn jettons', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        let burnAmount = toNano('0.01');
        const sendResult = await deployerJettonWallet.sendBurn(
            deployer.getSender(),
            toNano('0.1'), // ton amount
            burnAmount,
            deployer.address,
            beginCell().endCell(),
        ); // amount, response address, custom payload
        expect(sendResult.transactions).toHaveTransaction({
            //burn notification
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
        });
        expect(sendResult.transactions).toHaveTransaction({
            //excesses
            from: jettonMinter.address,
            to: deployer.address,
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - burnAmount);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply - burnAmount);
    });

    it('not wallet owner should not be able to burn jettons', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        let burnAmount = toNano('0.01');
        const sendResult = await deployerJettonWallet.sendBurn(
            notDeployer.getSender(),
            toNano('0.1'), // ton amount
            burnAmount,
            deployer.address,
            beginCell().endCell(),
        ); // amount, response address, custom payload
        expect(sendResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_owner, //error::unauthorized_transfer
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
    });

    it('wallet owner can not burn more jettons than it has', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        let burnAmount = initialJettonBalance + 1n;
        const sendResult = await deployerJettonWallet.sendBurn(
            deployer.getSender(),
            toNano('0.1'), // ton amount
            burnAmount,
            deployer.address,
            beginCell().endCell(),
        ); // amount, response address, custom payload
        expect(sendResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.balance_error, //error::not_enough_jettons
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
    });

    it('minimal burn message fee', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        let burnAmount = toNano('0.01');
        let fwd_fee = 1492012n /*1500012n*/,
            gas_consumption = 15000000n;
        let minimalFee = fwd_fee + 2n * gas_consumption;

        const sendLow = await deployerJettonWallet.sendBurn(
            deployer.getSender(),
            minimalFee, // ton amount
            burnAmount,
            deployer.address,
            beginCell().endCell(),
        ); // amount, response address, custom payload

        expect(sendLow.transactions).toHaveTransaction({
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_enough_gas, //error::burn_fee_not_matched
        });

        const sendExcess = await deployerJettonWallet.sendBurn(
            deployer.getSender(),
            minimalFee + 1n,
            burnAmount,
            deployer.address,
            beginCell().endCell(),
        );

        expect(sendExcess.transactions).toHaveTransaction({
            from: deployer.address,
            to: deployerJettonWallet.address,
            success: true,
        });

        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - burnAmount);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply - burnAmount);
    });

    it('minter should only accept burn messages from jetton wallets', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        const burnAmount = toNano('1');
        const burnNotification = (amount: bigint, addr: Address) => {
            return beginCell()
                .storeUint(Op.burn_notification, 32)
                .storeUint(0, 64)
                .storeCoins(amount)
                .storeAddress(addr)
                .storeAddress(deployer.address)
                .endCell();
        };

        let res = await blockchain.sendMessage(
            internal({
                from: deployerJettonWallet.address,
                to: jettonMinter.address,
                body: burnNotification(burnAmount, randomAddress(0)),
                value: toNano('0.1'),
            }),
        );

        expect(res.transactions).toHaveTransaction({
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
            aborted: true,
            exitCode: Errors.unouthorized_burn, // Unauthorized burn
        });

        res = await blockchain.sendMessage(
            internal({
                from: deployerJettonWallet.address,
                to: jettonMinter.address,
                body: burnNotification(burnAmount, deployer.address),
                value: toNano('0.1'),
            }),
        );

        expect(res.transactions).toHaveTransaction({
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
            success: true,
        });
    });

    // TEP-89
    it('report correct discovery address', async () => {
        let discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(), deployer.address, true);
        /*
          take_wallet_address#d1735400 query_id:uint64 wallet_address:MsgAddress owner_address:(Maybe ^MsgAddress) = InternalMsgBody;
        */
        const deployerJettonWallet = await userWallet(deployer.address);
        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell()
                .storeUint(Op.take_wallet_address, 32)
                .storeUint(0, 64)
                .storeAddress(deployerJettonWallet.address)
                .storeUint(1, 1)
                .storeRef(beginCell().storeAddress(deployer.address).endCell())
                .endCell(),
        });

        discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(), notDeployer.address, true);
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell()
                .storeUint(Op.take_wallet_address, 32)
                .storeUint(0, 64)
                .storeAddress(notDeployerJettonWallet.address)
                .storeUint(1, 1)
                .storeRef(beginCell().storeAddress(notDeployer.address).endCell())
                .endCell(),
        });

        // do not include owner address
        discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(), notDeployer.address, false);
        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell()
                .storeUint(Op.take_wallet_address, 32)
                .storeUint(0, 64)
                .storeAddress(notDeployerJettonWallet.address)
                .storeUint(0, 1)
                .endCell(),
        });
    });

    it('Minimal discovery fee', async () => {
        // 5000 gas-units + msg_forward_prices.lump_price + msg_forward_prices.cell_price = 0.0061
        const fwdFee = 1464012n;
        const minimalFee = fwdFee + 10000000n; // toNano('0.0061');

        let discoveryResult = await jettonMinter.sendDiscovery(
            deployer.getSender(),
            notDeployer.address,
            false,
            minimalFee,
        );

        expect(discoveryResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonMinter.address,
            aborted: true,
            exitCode: Errors.discovery_fee_not_matched, // discovery_fee_not_matched
        });

        /*
         * Might be helpfull to have logical OR in expect lookup
         * Because here is what is stated in standard:
         * and either throw an exception if amount of incoming value is not enough to calculate wallet address
         * or response with message (sent with mode 64)
         * https://github.com/ton-blockchain/TEPs/blob/master/text/0089-jetton-wallet-discovery.md
         * At least something like
         * expect(discoveryResult.hasTransaction({such and such}) ||
         * discoveryResult.hasTransaction({yada yada})).toBeTruethy()
         */
        discoveryResult = await jettonMinter.sendDiscovery(
            deployer.getSender(),
            notDeployer.address,
            false,
            minimalFee + 1n,
        );

        expect(discoveryResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonMinter.address,
            success: true,
        });
    });

    it('Correctly handles not valid address in discovery', async () => {
        const badAddr = randomAddress(-1);
        let discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(), badAddr, false);

        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell()
                .storeUint(Op.take_wallet_address, 32)
                .storeUint(0, 64)
                .storeUint(0, 2) // addr_none
                .storeUint(0, 1)
                .endCell(),
        });

        // Include address should still be available

        discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(), badAddr, true); // Include addr

        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell()
                .storeUint(Op.take_wallet_address, 32)
                .storeUint(0, 64)
                .storeUint(0, 2) // addr_none
                .storeUint(1, 1)
                .storeRef(beginCell().storeAddress(badAddr).endCell())
                .endCell(),
        });
    });

    // This test consume a lot of time: 18 sec
    // and is needed only for measuring ton accruing
    /*it('jettonWallet can process 250 transfer', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = 1n, count = 250n;
        let forwardAmount = toNano('0.05');
        let sendResult: any;
        let payload = beginCell()
                          .storeUint(0x12345678, 32).storeUint(0x87654321, 32)
                          .storeRef(beginCell().storeUint(0x12345678, 32).storeUint(0x87654321, 108).endCell())
                          .storeRef(beginCell().storeUint(0x12345671, 32).storeUint(0x87654321, 240).endCell())
                          .storeRef(beginCell().storeUint(0x12345672, 32).storeUint(0x87654321, 77)
                                               .storeRef(beginCell().endCell())
                                               .storeRef(beginCell().storeUint(0x1245671, 91).storeUint(0x87654321, 32).endCell())
                                               .storeRef(beginCell().storeUint(0x2245671, 180).storeUint(0x87654321, 32).endCell())
                                               .storeRef(beginCell().storeUint(0x8245671, 255).storeUint(0x87654321, 32).endCell())
                                    .endCell())
                      .endCell();
        let initialBalance =(await blockchain.getContract(deployerJettonWallet.address)).balance;
        let initialBalance2 = (await blockchain.getContract(notDeployerJettonWallet.address)).balance;
        for(let i = 0; i < count; i++) {
            sendResult = await deployerJettonWallet.sendTransferMessage(deployer.getSender(), toNano('0.1'), //tons
                   sentAmount, notDeployer.address,
                   deployer.address, null, forwardAmount, payload);
        }
        // last chain was successful
        expect(sendResult.transactions).toHaveTransaction({ //excesses
            from: notDeployerJettonWallet.address,
            to: deployer.address,
        });
        expect(sendResult.transactions).toHaveTransaction({ //notification
            from: notDeployerJettonWallet.address,
            to: notDeployer.address,
            value: forwardAmount
        });

        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount*count);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2 + sentAmount*count);

        let finalBalance =(await blockchain.getContract(deployerJettonWallet.address)).balance;
        let finalBalance2 = (await blockchain.getContract(notDeployerJettonWallet.address)).balance;

        // if it is not true, it's ok but gas_consumption constant is too high
        // and excesses of TONs will be accrued on wallet
        expect(finalBalance).toBeLessThan(initialBalance + toNano('0.001'));
        expect(finalBalance2).toBeLessThan(initialBalance2 + toNano('0.001'));
        expect(finalBalance).toBeGreaterThan(initialBalance - toNano('0.001'));
        expect(finalBalance2).toBeGreaterThan(initialBalance2 - toNano('0.001'));

    });
    */
    // implementation detail
    it('can not send to masterchain', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        const sendResult = await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            Address.parse('Ef8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAU'),
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );
        expect(sendResult.transactions).toHaveTransaction({
            //excesses
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.wrong_workchain, //error::wrong_workchain
        });
    });
    describe('Bounces', () => {
        // This is borrowed from stablecoin, and is not implemented here.
        // Should it be implemented?
        it.skip('minter should restore supply on internal_transfer bounce', async () => {
            const deployerJettonWallet = await userWallet(deployer.address);
            const mintAmount = BigInt(getRandomInt(1000, 2000));
            const mintMsg = JettonMinter.mintMessage(
                jettonMinter.address,
                deployer.address,
                mintAmount,
                toNano('0.1'),
                toNano('0.1'),
            );

            const supplyBefore = await jettonMinter.getTotalSupply();
            const minterSmc = await blockchain.getContract(jettonMinter.address);

            // Sending message but only processing first step of tx chain
            let res = minterSmc.receiveMessage(
                internal({
                    from: deployer.address,
                    to: jettonMinter.address,
                    body: mintMsg,
                    value: toNano('1'),
                }),
            );

            expect((await res).outMessagesCount).toEqual(1);
            const outMsgSc = (await res).outMessages.get(0)!.body.beginParse();
            expect(outMsgSc.preloadUint(32)).toEqual(Op.internal_transfer);

            expect(await jettonMinter.getTotalSupply()).toEqual(supplyBefore + mintAmount);

            minterSmc.receiveMessage(
                internal({
                    from: deployerJettonWallet.address,
                    to: jettonMinter.address,
                    bounced: true,
                    body: beginCell().storeUint(0xffffffff, 32).storeSlice(outMsgSc).endCell(),
                    value: toNano('0.95'),
                }),
            );

            // Supply should change back
            expect(await jettonMinter.getTotalSupply()).toEqual(supplyBefore);
        });
        it('wallet should restore balance on internal_transfer bounce', async () => {
            const deployerJettonWallet = await userWallet(deployer.address);
            const notDeployerJettonWallet = await userWallet(notDeployer.address);
            const balanceBefore = await deployerJettonWallet.getJettonBalance();
            const txAmount = BigInt(getRandomInt(100, 200));
            const transferMsg = JettonWallet.transferMessage(
                txAmount,
                notDeployer.address,
                deployer.address,
                null,
                0n,
                null,
            );

            const walletSmc = await blockchain.getContract(deployerJettonWallet.address);

            const res = walletSmc.receiveMessage(
                internal({
                    from: deployer.address,
                    to: deployerJettonWallet.address,
                    body: transferMsg,
                    value: toNano('1'),
                }),
            );

            expect((await res).outMessagesCount).toEqual(1);

            const outMsgSc = (await res).outMessages.get(0)!.body.beginParse();
            expect(outMsgSc.preloadUint(32)).toEqual(Op.internal_transfer);

            expect(await deployerJettonWallet.getJettonBalance()).toEqual(balanceBefore - txAmount);

            walletSmc.receiveMessage(
                internal({
                    from: notDeployerJettonWallet.address,
                    to: walletSmc.address,
                    bounced: true,
                    body: beginCell().storeUint(0xffffffff, 32).storeSlice(outMsgSc).endCell(),
                    value: toNano('0.95'),
                }),
            );

            // Balance should roll back
            expect(await deployerJettonWallet.getJettonBalance()).toEqual(balanceBefore);
        });
        it('wallet should restore balance on burn_notification bounce', async () => {
            const deployerJettonWallet = await userWallet(deployer.address);
            const balanceBefore = await deployerJettonWallet.getJettonBalance();
            const burnAmount = BigInt(getRandomInt(100, 200));

            const burnMsg = JettonWallet.burnMessage(burnAmount, deployer.address, null);

            const walletSmc = await blockchain.getContract(deployerJettonWallet.address);

            const res = walletSmc.receiveMessage(
                internal({
                    from: deployer.address,
                    to: deployerJettonWallet.address,
                    body: burnMsg,
                    value: toNano('1'),
                }),
            );

            expect((await res).outMessagesCount).toEqual(1);

            const outMsgSc = (await res).outMessages.get(0)!.body.beginParse();
            expect(outMsgSc.preloadUint(32)).toEqual(Op.burn_notification);

            expect(await deployerJettonWallet.getJettonBalance()).toEqual(balanceBefore - burnAmount);

            walletSmc.receiveMessage(
                internal({
                    from: jettonMinter.address,
                    to: walletSmc.address,
                    bounced: true,
                    body: beginCell().storeUint(0xffffffff, 32).storeSlice(outMsgSc).endCell(),
                    value: toNano('0.95'),
                }),
            );

            // Balance should roll back
            expect(await deployerJettonWallet.getJettonBalance()).toEqual(balanceBefore);
        });
    });

    // Current wallet version doesn't support those operations
    // implementation detail
    it.skip('owner can withdraw excesses', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        await deployer.send({ value: toNano('1'), bounce: false, to: deployerJettonWallet.address });
        let initialBalance = (await blockchain.getContract(deployer.address)).balance;
        const withdrawResult = await deployerJettonWallet.sendWithdrawTons(deployer.getSender());
        expect(withdrawResult.transactions).toHaveTransaction({
            //excesses
            from: deployerJettonWallet.address,
            to: deployer.address,
        });
        let finalBalance = (await blockchain.getContract(deployer.address)).balance;
        let finalWalletBalance = (await blockchain.getContract(deployerJettonWallet.address)).balance;
        expect(finalWalletBalance).toEqual(min_tons_for_storage);
        expect(finalBalance - initialBalance).toBeGreaterThan(toNano('0.99'));
    });
    // implementation detail
    it.skip('not owner can not withdraw excesses', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        await deployer.send({ value: toNano('1'), bounce: false, to: deployerJettonWallet.address });
        let initialBalance = (await blockchain.getContract(deployer.address)).balance;
        const withdrawResult = await deployerJettonWallet.sendWithdrawTons(notDeployer.getSender());
        expect(withdrawResult.transactions).not.toHaveTransaction({
            //excesses
            from: deployerJettonWallet.address,
            to: deployer.address,
        });
        let finalBalance = (await blockchain.getContract(deployer.address)).balance;
        let finalWalletBalance = (await blockchain.getContract(deployerJettonWallet.address)).balance;
        expect(finalWalletBalance).toBeGreaterThan(toNano('1'));
        expect(finalBalance - initialBalance).toBeLessThan(toNano('0.1'));
    });
    // implementation detail
    it.skip('owner can withdraw jettons owned by JettonWallet', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            deployerJettonWallet.address,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );
        const childJettonWallet = await userWallet(deployerJettonWallet.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialChildJettonBalance = await childJettonWallet.getJettonBalance();
        expect(initialChildJettonBalance).toEqual(toNano('0.5'));
        let withdrawResult = await deployerJettonWallet.sendWithdrawJettons(
            deployer.getSender(),
            childJettonWallet.address,
            toNano('0.4'),
        );
        expect((await deployerJettonWallet.getJettonBalance()) - initialJettonBalance).toEqual(toNano('0.4'));
        expect(await childJettonWallet.getJettonBalance()).toEqual(toNano('0.1'));
        //withdraw the rest
        await deployerJettonWallet.sendWithdrawJettons(deployer.getSender(), childJettonWallet.address, toNano('0.1'));
    });
    // implementation detail
    it.skip('not owner can not withdraw jettons owned by JettonWallet', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        await deployerJettonWallet.sendTransfer(
            deployer.getSender(),
            toNano('0.1'), //tons
            sentAmount,
            deployerJettonWallet.address,
            deployer.address,
            beginCell().endCell(),
            forwardAmount,
            beginCell().endCell(),
        );
        const childJettonWallet = await userWallet(deployerJettonWallet.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialChildJettonBalance = await childJettonWallet.getJettonBalance();
        expect(initialChildJettonBalance).toEqual(toNano('0.5'));
        let withdrawResult = await deployerJettonWallet.sendWithdrawJettons(
            notDeployer.getSender(),
            childJettonWallet.address,
            toNano('0.4'),
        );
        expect((await deployerJettonWallet.getJettonBalance()) - initialJettonBalance).toEqual(toNano('0.0'));
        expect(await childJettonWallet.getJettonBalance()).toEqual(toNano('0.5'));
    });
});
