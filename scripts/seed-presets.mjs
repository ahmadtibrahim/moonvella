import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PRESETS = [
  { name: "Small carton", packageType: "carton", length: 25, width: 20, height: 10, emptyWeight: 0.2, maxWeight: 5 },
  { name: "Medium carton", packageType: "carton", length: 40, width: 30, height: 20, emptyWeight: 0.4, maxWeight: 15 },
  { name: "Large carton", packageType: "carton", length: 60, width: 45, height: 35, emptyWeight: 0.8, maxWeight: 30 },
  { name: "Mailer", packageType: "mailer", length: 35, width: 25, height: 3, emptyWeight: 0.1, maxWeight: 2 },
  { name: "Custom package", packageType: "custom", length: 1, width: 1, height: 1, emptyWeight: 0, maxWeight: null },
];

for (const p of PRESETS) {
  await prisma.packagingPreset.upsert({
    where: { name: p.name },
    create: { name: p.name, packageType: p.packageType, length: p.length, width: p.width, height: p.height, dimensionUnit: "cm", emptyWeight: p.emptyWeight, weightUnit: "kg", maxWeight: p.maxWeight },
    update: {},
  });
  console.log("preset:", p.name);
}
await prisma.$disconnect();
