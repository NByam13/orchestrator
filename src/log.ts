const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const log = {
    info: (scope: string, msg: string) => console.log(`${stamp()}  ${scope.padEnd(12)} ${msg}`),
    warn: (scope: string, msg: string) => console.warn(`${stamp()}  ${scope.padEnd(12)} ⚠ ${msg}`),
    error: (scope: string, msg: string) => console.error(`${stamp()}  ${scope.padEnd(12)} ✖ ${msg}`),
};
