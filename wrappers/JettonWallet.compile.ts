import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    targets: [
        'contracts/imports/stdlib.fc',
        'contracts/imports/params.fc',
        'contracts/imports/op-codes.fc',
        'contracts/imports/jetton-utils.fc',
        'contracts/jetton-wallet.fc',
    ],
};
