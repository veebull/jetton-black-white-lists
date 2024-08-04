# jetton-black-n-white-lists

## Jetton token for TON ecosystem with black and white lists written in FunC.

This jetton allows you to set one address to blacklist and add or remove multiple addresses to whitelist.
If address is in blacklist and in whitelist in same time, you can send to this address.

## Content

-   [Project structure](#project-structure)
-   [How to use](#how-to-use)
-   [Instructions](#instructions)
-   [Notes](#notes)
-   [Roadmdap](#roadmap)

## Project structure

-   `contracts` - source code of all the smart contracts of the project and their dependencies.
-   `wrappers` - wrapper classes (implementing `Contract` from ton-core) for the contracts, including any [de]serialization primitives and compilation functions.
-   `tests` - tests for the contracts.
-   `scripts` - scripts used by the project, mainly the deployment scripts.

## How to use

### Build

`npx blueprint build` or `yarn blueprint build`

### Test

`npx blueprint test` or `yarn blueprint test`

### Deploy or run another script

`npx blueprint run` or `yarn blueprint run`

### Add a new contract

`npx blueprint create ContractName` or `yarn blueprint create ContractName`

## Instructions

1.  npm i
2.  Need to fix `@ton/blueprint` typescript library

    -   Go to node_modules/@ton/blueprint/dist/network/NetworkProvider.d.ts
    -   Or just click to NetworkProvider in [scripts/bwController.ts](scripts/bwController.ts) on 46 line of code

    #### Need to replace | to & to avoid typescript errors.

    ```diff
    - api(): TonClient4 | TonClient;
    + api(): TonClient4 & TonClient;
    ```

3.  To build all contracts at once write in terminal
    ```
    npx blueprint build --all
    ```
4.  You need mnemonic phrase of your wallet to interact with contract. Write in terminal to create .env
    ```
    touch .env
    ```
5.  replace WALLET_MNEMONIC variable with your 24 words of seed phrase
6.  Be sure that on this wallet there is enough money for deploying and other actions with smart contract
7.  Upload your metadata.json file to github or another internet place. File to upload locate in path [data/jetton-metadata.json](data/jetton-metadata.json). When you upload get link with raw data only.

    ```
    {
     "name": "BW Jetton",
     "description": "Sample BW of Jetton",
     "symbol": "BWJ",
     "decimals": 9,
     "image": "https://avatars.githubusercontent.com/u/104382459?s=80&v=4"
    }

    ```

8.  To deploy Jetton Minter write
    ```
     npx blueprint run deployJettonMinterDiscoverable
    ```
    1. Then select `mainnet` or `testnet`
    2. Then select `Mnemonic`
       Or for shortcut write
    ```
    npx blueprint run deployJettonMinterDiscoverable --testnet --mnemonic --tonviewer
    ```
    3. Press enter to select admin as address of your wallet
    4. Paste jetton-metadata.json raw link from github or your another place
    5. Write `y` and hit enter or `n` to redo previous step
       After that there maybe several options.
        1. `Success!` You are see your minter address and link in scan. Copy address and go to the next step.
        2. `Contract is already deployed` It means that contract at your wallet with that code of jetton minter and metadata link is already deployed. If your want create new, just change the link of your metadata.json to metadata-1.json (or add another character) and paste it the next time. It is the quick way to fix that. Later I will add on chain data to play with it more better.
        3. `Fetch failed`, `error with orbs.network` and etc. Please turn off vpn, check your internet connection and try again. It is problem with network.
9.  Open [scripts/bwController.ts](scripts/bwController.ts) (bw is **b**lack and **w**hite), scroll to the almost of the ending of file and to the `499 line` of code replace address of minterAddress constant for new deployed contract of the previous step. Double check this step. If you miss this step. There will be notification that data in contract don't match with provided data.
10. Next step is minting tokens. Write in terminal command below or if you already have options skip this step.

    ```
    npx blueprint run bwController
    ```

    1. Then select `mainnet` or `testnet`
    2. Then select `Mnemonic`
       Or for shortcut write

    ```
    npx blueprint run bwController --testnet --mnemonic --tonviewer
    ```

    3. If you are admin of the contract you will see admin + user actions, if not, only user actions.
    4. By arrows choose `Mint` and hit enter
    5. Hit enter to select your address as destination of minting tokens. You can paste any address
    6. Write by numbers how much your want to mint. Any number multiple for `1e9`, eg. You write 123. Then you get 123 000 000 000 jettons to your wallet.
    7. Write `yes` and hit enter or `no` for redo prev step.
    8. After successfully minted, check your address.

11. To `Transfer` write in terminal:
    ```
    npx blueprint run bwController --testnet --mnemonic --tonviewer
    ```
    1. Select `Transfer`
    2. Paste here addres to transfer and hit enter
    3. Write amount in numbers. If your write `777` tokens, you will transfer `777` tokens to your address
    4. Write `yes` and hit enter or `no` for redo prev step.
    5. Success!
12. To `Set address to blacklist` write command below or skip this step if you have already menu options.
    ```
    npx blueprint run bwController --testnet --mnemonic --tonviewer
    ```
    1. Select `Set blacklist address`
    2. Paste address for blacklist and hit enter. You can set only one blacklist address in one time. If you want replace with new blacklist address just re-choose it and retry all commands again.
    3. Write `y` and hit enter to set address or `n` for re-paste it.
    4. Success!
13. To `Add address to whitelist` write command below or skip this step if you have already menu options.
    ```
    npx blueprint run bwController --testnet --mnemonic --tonviewer
    ```
    1. Select `Add address to whitelist`
    2. Paste address to add to whitelist and hit enter
    3. Write `y` and hit enter to set address or `n` for re-paste it.
    4. Success!
14. To `Remove address from whitelist` write command below or skip this step if you have already menu options.
    ```
    npx blueprint run bwController --testnet --mnemonic --tonviewer
    ```
    1. Select `Remove address from whitelist`
    2. Paste exact address to remove matched address from whitelist and hit enter
    3. Write `y` and hit enter to set address or `n` for re-paste it.
    4. Success!
15. To `Witdhraw TON from Jetton Minter` write command below or skip this step if you have already menu options.
    ```
    npx blueprint run bwController --testnet --mnemonic --tonviewer
    ```
    1. Select `Witdhraw TON from Jetton Minter`
    2. Wait some time. Script fetch balance of Jetton Minter...
    3. Write exact amount of TON you want to withdraw in float mode. Eg. 1.115. Then JettonMinter will send to you 1.115000000 TON. It automatically converts to TON format underhood.
    4. If you write greater or negative or zero amount you will appropriate warning and another try to write correct amount
    5. Write `yes` and hit enter to set address or `no` for re-write it.
    6. Success!
16. Also you have Info actions. Choose what you like and get specific data you want.

    -   `Get blacklist address`
    -   `Get whitelist address(es)`
    -   `Jetton Info`

17. Always you can select `Quit` option to go out from this menu.

### Notes

-   ✅ Works properly on wallet v4
-   ⛔️ Works unstable on wallet v5, need update of blueprint, I [commited update](https://github.com/ton-org/blueprint/compare/main...veebull:blueprint:patch-1), below there is instructions how to hardcode update yourself in blueprint module.
-   Everytime Jetton Minter increase self TON balance on every transaction. That's why there is for admin withdraw function.
-   To do work for wallet v5 need:
    1. Go to [node_modules/@ton/blueprint/dist/network/send/MnemonicProvider.js](node_modules/@ton/blueprint/dist/network/send/MnemonicProvider.js) and at 28 line of code add `v5r1: ton_1.WalletContractV5R1,`
    ```diff
    const wallets = {
    v1r1: ton_1.WalletContractV1R1,
    v1r2: ton_1.WalletContractV1R2,
    v1r3: ton_1.WalletContractV1R3,
    v2r1: ton_1.WalletContractV2R1,
    v2r2: ton_1.WalletContractV2R2,
    v3r1: ton_1.WalletContractV3R1,
    v3r2: ton_1.WalletContractV3R2,
    v4: ton_1.WalletContractV4,
    + v5r1: ton_1.WalletContractV5R1,
    };
    ```
    2. Then when you will paste mnemonic phrase second line of code will be `WALLET_VERSION=v5r1`

### Roadmap

-   Write tlb schemes for new functions
-   Finish tests and complete whole run of tests to green
-   Add opportunity to choose offchain or onchain metadata
-   Fix onchain metadata function in wrapper
-   Add wallet v5 support
-   Add for withdraw function in Jetton Minter to not spend TON for withdraw for rent and gas.
