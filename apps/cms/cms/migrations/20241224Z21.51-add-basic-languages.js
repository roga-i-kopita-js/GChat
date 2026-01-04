const LANGUAGES_TABLE_NAME = 'languages';

export async function up(knex) {
    await knex.schema.createTableIfNotExists(
        LANGUAGES_TABLE_NAME,
        (table) => {
            table.string('code', 255).notNullable().primary().unique();
            table.string('direction', 255).defaultTo('ltr');
            table.string('name', 255).notNullable().defaultTo('').unique();
        },
    );

   const count = await knex(LANGUAGES_TABLE_NAME).count('code');

   if (count[0]['count(`code`)'] === 0) {
       await knex(LANGUAGES_TABLE_NAME).insert([
           {code: 'en', direction: 'ltr', name: 'English'},
       ])
   }
}