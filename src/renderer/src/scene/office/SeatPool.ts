/**
 * 固定有序座位标识符列表（Tiled 地图里的桌/电脑生成点）的预留池。用于给每个
 * 动态添加的 agent 一个不同的座位。从 shahar061/the-office 逐字移植
 * （office/SeatPool.ts）。
 */
export class SeatPool {
  private readonly seats: readonly string[];
  private claimed = new Set<string>();

  constructor(seats: readonly string[]) {
    this.seats = seats;
  }

  /** 按列表顺序预留第一个未占用座位；全被占用则返回 null。 */
  reserveNext(): string | null {
    for (const seat of this.seats) {
      if (!this.claimed.has(seat)) {
        this.claimed.add(seat);
        return seat;
      }
    }
    return null;
  }

  /** 释放之前预留的座位。幂等。 */
  release(seat: string): void {
    this.claimed.delete(seat);
  }

  isReserved(seat: string): boolean {
    return this.claimed.has(seat);
  }
}
