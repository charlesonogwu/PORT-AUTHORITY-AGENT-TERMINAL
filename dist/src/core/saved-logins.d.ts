import { Lane } from "./lane.js";
/** Retain only the exact site host; never store URL paths, queries or credentials. */
export declare function normalizeLoginWebsite(value: string): string;
export declare function rememberSavedLogin(laneId: string, input: {
    website: string;
    confirmed: boolean;
    accountLabel?: string;
}): Promise<Lane>;
export declare function findSavedLogins(input: {
    cwd: string;
    website: string;
    accountLabel?: string;
}): Promise<{
    lanes: Lane[];
    unavailableProfileIds: string[];
    reconnect: {
        laneId: string;
        command: string;
    } | null;
}>;
