'use strict';

// Foreign keys run after every original table exists. ChuyenXes predates LoaiXes.
const relations = [
  ['ChuyenXes', 'carId', 'NhaXes', 'RESTRICT'],
  ['ChuyenXes', 'cateCarId', 'LoaiXes', 'RESTRICT'],
  ['VeDaDats', 'jourId', 'ChuyenXes', 'RESTRICT'],
  ['VeDaDats', 'accId', 'TaiKhoans', 'RESTRICT'],
  ['Reviews', 'accId', 'TaiKhoans', 'CASCADE'],
  ['Reviews', 'carId', 'NhaXes', 'CASCADE'],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      for (const [table, column, parent, onDelete] of relations) {
        const description = await queryInterface.describeTable(table, { transaction });
        if (!description[column]) {
          await queryInterface.addColumn(table, column, { type: Sequelize.INTEGER, allowNull: true }, { transaction });
        }
        const [missing] = await queryInterface.sequelize.query(
          `SELECT COUNT(*) AS count FROM "${table}" child LEFT JOIN "${parent}" parent ON child."${column}" = parent.id WHERE parent.id IS NULL`,
          { transaction }
        );
        if (Number(missing[0].count)) {
          throw new Error(`Legacy ${table}.${column} contains missing or orphaned references. Backfill those rows with existing ${parent}.id values before retrying. No data was deleted.`);
        }
        await queryInterface.changeColumn(table, column, { type: Sequelize.INTEGER, allowNull: false }, { transaction });
        await queryInterface.addConstraint(table, {
          fields: [column], type: 'foreign key', name: `fk_${table}_${column}`,
          references: { table: parent, field: 'id' }, onUpdate: 'CASCADE', onDelete, transaction,
        });
        await queryInterface.addIndex(table, [column], { name: `idx_${table}_${column}`, transaction });
      }
      await queryInterface.addIndex('ChuyenXes', ['startProvince', 'endProvince', 'startDate'], { name: 'idx_legacy_trip_search', transaction });
      await queryInterface.addConstraint('Reviews', {
        fields: ['stars'], type: 'check', name: 'check_legacy_review_stars',
        where: { stars: { [Sequelize.Op.gte]: 1, [Sequelize.Op.lte]: 5 } }, transaction,
      });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.removeConstraint('Reviews', 'check_legacy_review_stars', { transaction });
      await queryInterface.removeIndex('ChuyenXes', 'idx_legacy_trip_search', { transaction });
      for (const [table, column] of [...relations].reverse()) {
        await queryInterface.removeIndex(table, `idx_${table}_${column}`, { transaction });
        await queryInterface.removeConstraint(table, `fk_${table}_${column}`, { transaction });
      }
    });
  },
};
