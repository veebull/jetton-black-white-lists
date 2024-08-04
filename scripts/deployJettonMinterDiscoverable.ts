import { Address, toNano, Dictionary, Cell, beginCell } from '@ton/core';
import {
    JettonMinter,
    jettonOffChainContentToCell,
    jettonOnChainContentToCell,
    jettonContentOffChainToCell,
    jettonMinterConfigToCell,
} from '../wrappers/JettonMinterDiscoverable';
import { compile, NetworkProvider, UIProvider } from '@ton/blueprint';
import { promptAddress, promptBool, promptUrl } from '../wrappers/ui-utils';
import jettonMinterContent from '../data/jetton-metadata.json';

const formatUrl =
    'https://github.com/ton-blockchain/TEPs/blob/master/text/0064-token-data-standard.md#jetton-metadata-example-offchain';

const urlPrompt = 'Please specify url pointing to jetton metadata(json):';

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const adminPrompt = `Please specify admin address`;
    ui.write(`Jetton deployer\nCurrent deployer onli supports off-chain format:${formatUrl}`);

    let admin = await promptAddress(adminPrompt, ui, sender.address);
    ui.write(`Admin address:${admin}\n`);
    let contentUrl = await promptUrl(urlPrompt, ui);
    ui.write(`Jetton content url:${contentUrl}`);
    // Нулевой адрес
    const blacklisted = Address.parseRaw('0:0000000000000000000000000000000000000000000000000000000000000000');
    // Пустой словарь
    const whitelistDict = Dictionary.empty();
    // Ячейка с пустым словарем
    const whitelist = beginCell().storeDict(whitelistDict).endCell();

    let dataCorrect = false;
    do {
        ui.write('Please verify data:\n');
        ui.write(`Admin:${admin}\n\n`);
        ui.write('Metadata url:' + contentUrl);
        dataCorrect = await promptBool('Is everything ok?(y/n)', ['y', 'n'], ui);
        if (!dataCorrect) {
            const upd = await ui.choose('What do you want to update?', ['Admin', 'Url'], (c) => c);

            if (upd == 'Admin') {
                admin = await promptAddress(adminPrompt, ui, sender.address);
            } else {
                contentUrl = await promptUrl(urlPrompt, ui);
            }
        }
    } while (!dataCorrect);

    const content = jettonOffChainContentToCell({ type: 1, uri: contentUrl });
    // const content = jettonOnChainContentToCell(jettonMinterContent);

    const wallet_code = await compile('JettonWallet');

    const minter = JettonMinter.createFromConfig(
        { admin, content, wallet_code, blacklisted, whitelist },
        await compile('JettonMinterDiscoverable'),
    );

    await provider.deploy(minter, toNano('0.15'));
}
