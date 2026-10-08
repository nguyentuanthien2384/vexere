'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Review extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
      Review.belongsTo(models.TaiKhoan, { foreignKey: 'accId' });
      Review.belongsTo(models.NhaXe, { foreignKey: 'carId' });
    }
  }
  Review.init({
    stars: { type: DataTypes.FLOAT, allowNull: false, validate: { min: 1, max: 5 } },
    comment: DataTypes.TEXT,
    accId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'TaiKhoans', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    },
    carId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'NhaXes', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    }
  }, {
    sequelize,
    modelName: 'Review',
  });
  return Review;
};
