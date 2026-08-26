export type Digest = {
  algorithm: "sha256";
  value: string;
};

export type TaskCondition = {
  packetRef: {
    locator: string;
    digest: Digest;
  };
};

export type TaskConditionSet = Record<string, TaskCondition>;

export type ResolvedTaskPacket = {
  digest: Digest;
  admission: {
    status: "proposed" | "admitted" | "rejected";
  };
};

export function assertAdmittedTaskPackets(
  taskSet: TaskConditionSet,
  resolvedPackets: Record<string, ResolvedTaskPacket>,
): void {
  for (const [taskId, condition] of Object.entries(taskSet)) {
    const packet = resolvedPackets[taskId];

    if (packet === undefined) {
      throw new Error(`Task packet "${taskId}" did not resolve.`);
    }
    if (
      packet.digest.algorithm !== condition.packetRef.digest.algorithm
      || packet.digest.value !== condition.packetRef.digest.value
    ) {
      throw new Error(`Task packet "${taskId}" digest does not match its reference.`);
    }
    if (packet.admission.status !== "admitted") {
      throw new Error(`Task packet "${taskId}" is not admitted.`);
    }
  }
}
