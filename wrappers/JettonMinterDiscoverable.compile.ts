import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    targets: [
        'contracts/jetton-minter-discoverable.fc',
        'contracts/imports/discovery-params.fc',
        'contracts/imports/jetton-utils.fc',
        'contracts/imports/op-codes.fc',
        'contracts/imports/params.fc',
        'contracts/imports/stdlib.fc',
    ],
};
