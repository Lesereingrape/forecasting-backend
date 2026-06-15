import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { id: 1 },
    update: { balance: 1000 },
    create: { id: 1, username: "alice", balance: 1000 }
  });

  await prisma.user.upsert({
    where: { id: 2 },
    update: { balance: 500 },
    create: { id: 2, username: "bob", balance: 500 }
  });

  await prisma.ledgerEntry.deleteMany({
    where: {
      betId: null,
      type: "DEPOSIT",
      userId: { in: [1, 2] }
    }
  });

  await prisma.ledgerEntry.createMany({
    data: [
      { userId: 1, type: "DEPOSIT", amount: 1000 },
      { userId: 2, type: "DEPOSIT", amount: 500 }
    ]
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
