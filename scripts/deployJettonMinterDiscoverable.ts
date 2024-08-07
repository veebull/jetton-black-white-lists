import { Address, toNano, Dictionary, Cell, beginCell, OpenedContract } from '@ton/core';
import {
    JettonMinter,
    jettonContentOffChainToCell,
    jettonContentOnChainToCell,
    jettonMinterConfigToCell,
} from '../wrappers/JettonMinterDiscoverable';
import { compile, NetworkProvider, UIProvider } from '@ton/blueprint';
import { promptAddress, promptBool, promptUrl } from '../wrappers/ui-utils';
import * as fs from 'fs/promises';

const METADATA_PATH = 'data/jetton-metadata.json';
const formatUrl =
    'https://github.com/ton-blockchain/TEPs/blob/master/text/0064-token-data-standard.md#jetton-metadata-example-offchain';

async function changeMetadataBy(key: string, ui: UIProvider): Promise<void> {
    try {
        // Чтение JSON-файла
        const fileContent = await fs.readFile(METADATA_PATH, 'utf-8');
        let data: Record<string, any> = JSON.parse(fileContent);

        // Запрос нового значения у пользователя
        let newValue: string;
        if (key == 'image') {
            newValue = await promptUrl(`Write new url for ${key} (default: "${data[key]}")`, ui);
        } else {
            newValue = await ui.input(`Write new ${key} (default: "${data[key]}"): `);
        }

        // Обновление данных
        if (key in data) {
            if (key == 'decimals') {
                data[key] = Number(newValue);
            } else {
                data[key] = newValue;
            }
            console.log(`Значение для ключа '${key}' обновлено.`);
        } else {
            const response = await ui.input(`Ключ '${key}' не найден. Добавить его? (y/n): `);
            if (response.toLowerCase() === 'y') {
                data[key] = newValue;
                console.log(`Добавлен новый ключ '${key}' со значением.`);
            } else {
                console.log('Операция отменена.');
                return;
            }
        }

        // Запись обновленных данных обратно в файл
        await fs.writeFile(METADATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
        console.log('JSON-файл успешно обновлен.');
    } catch (error) {
        console.error('Произошла ошибка при обновлении файла:', error);
    }
}

const onChainMetadatAction = async (provider: NetworkProvider, ui: UIProvider, admin: Address, adminPrompt: string) => {
    const sender = provider.sender();

    let dataCorrect = false;
    const jettonFileContent = await fs.readFile(METADATA_PATH, 'utf-8');
    const jettonMetadata = JSON.stringify(JSON.parse(jettonFileContent), null, 2);
    do {
        ui.write('Please verify data:\n');
        ui.write(`Admin:${admin}\n\n`);

        ui.write('Onchain Metadata:\n' + jettonMetadata);

        dataCorrect = await promptBool('Is everything ok?(y/n)', ['y', 'n'], ui);
        if (!dataCorrect) {
            const upd = await ui.choose(
                'What do you want to update?',
                ['Admin', 'Name', 'Description', 'Symbol', 'Decimals', 'Image', 'Quit'],
                (c) => c,
            );

            switch (upd) {
                case 'Admin':
                    admin = await promptAddress(adminPrompt, ui, sender.address);
                    break;
                case 'Name':
                    await changeMetadataBy('name', ui);
                    break;
                case 'Description':
                    await changeMetadataBy('description', ui);
                    break;
                case 'Symbol':
                    await changeMetadataBy('symbol', ui);
                    break;
                case 'Decimals':
                    await changeMetadataBy('decimals', ui);
                    break;
                case 'Image Url':
                    await changeMetadataBy('image', ui);
                    break;
                case 'Quit':
                    break;

                default:
                    break;
            }
        }
    } while (!dataCorrect);

    // const content = jettonContentOffChainToCell({ type: 1, uri: contentUrl });
    const content = jettonContentOnChainToCell({ type: 0, json: JSON.parse(jettonFileContent) });
    await deploy(provider, admin, content);
    return true;
};
const offChainMetadatAction = async (
    provider: NetworkProvider,
    ui: UIProvider,
    admin: Address,
    adminPrompt: string,
) => {
    const sender = provider.sender();

    const urlPrompt = 'Please specify url pointing to jetton metadata(json):';
    let contentUrl = await promptUrl(urlPrompt, ui);
    ui.write(`Jetton content url:${contentUrl}`);

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

    const content: Cell = jettonContentOffChainToCell({ type: 1, uri: contentUrl });
    await deploy(provider, admin, content);
    return true;
};
export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const adminPrompt = `Please specify admin address`;
    let done = false;

    ui.write(`Jetton deployer\nCurrent deployer onli supports off-chain format:${formatUrl}`);

    let admin = await promptAddress(adminPrompt, ui, sender.address);
    ui.write(`Admin address:${admin}\n`);

    const metadataTypeActions = ['OnChain (local json file)', 'OffChain (external url link)'];
    const actionList = [...metadataTypeActions];
    let content: Cell = beginCell().endCell();
    do {
        const action = await ui.choose('Pick action:', actionList, (c) => c);
        switch (action) {
            case 'OnChain (local json file)':
                done = await onChainMetadatAction(provider, ui, admin, adminPrompt);
                break;
            case 'OffChain (external url link)':
                done = await offChainMetadatAction(provider, ui, admin, adminPrompt);
                break;
        }
    } while (!done);
}

const deploy = async (provider: NetworkProvider, admin: Address, content: Cell) => {
    // Нулевой адрес
    const blacklisted = Address.parseRaw('0:0000000000000000000000000000000000000000000000000000000000000000');
    // Пустой словарь
    const whitelistDict = Dictionary.empty();
    // Ячейка с пустым словарем
    const whitelist = beginCell().storeDict(whitelistDict).endCell();

    const wallet_code = await compile('JettonWallet');

    let jettonMinter: OpenedContract<JettonMinter>;

    jettonMinter = provider.open(
        JettonMinter.createFromConfig(
            { admin, content, wallet_code, blacklisted, whitelist },
            await compile('JettonMinterDiscoverable'),
        ),
    );

    await jettonMinter.sendDeploy(provider.sender(), toNano('0.15'));

    await provider.waitForDeploy(jettonMinter.address, 20, 1000);
};
