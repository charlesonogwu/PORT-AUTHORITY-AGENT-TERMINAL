export const SUPERVISOR_PROTOCOL_VERSION = 1;
export function assertLaneId(value) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
        throw new Error("laneId must be a non-empty string of at most 512 characters");
    }
}
