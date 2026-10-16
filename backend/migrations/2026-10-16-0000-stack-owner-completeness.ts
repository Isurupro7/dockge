import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    if (!await knex.schema.hasColumn("stack_owner", "cpu_complete")) {
        await knex.schema.alterTable("stack_owner", (table) => {
            table.boolean("cpu_complete").notNullable().defaultTo(false);
        });
    }

    if (!await knex.schema.hasColumn("stack_owner", "memory_complete")) {
        await knex.schema.alterTable("stack_owner", (table) => {
            table.boolean("memory_complete").notNullable().defaultTo(false);
        });
    }
}

export async function down(knex: Knex): Promise<void> {
    const hasCpuComplete = await knex.schema.hasColumn("stack_owner", "cpu_complete");
    const hasMemoryComplete = await knex.schema.hasColumn("stack_owner", "memory_complete");
    if (hasCpuComplete || hasMemoryComplete) {
        await knex.schema.alterTable("stack_owner", (table) => {
            if (hasCpuComplete) {
                table.dropColumn("cpu_complete");
            }
            if (hasMemoryComplete) {
                table.dropColumn("memory_complete");
            }
        });
    }
}
