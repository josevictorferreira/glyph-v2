// Live connection vocabulary (spec 0015). Lives in shared so both
// features/live (producer) and shared/ui indicators (consumer) can use it
// without shared reaching into features.
export type LiveStatus = "connecting" | "connected" | "reconnecting" | "offline";
