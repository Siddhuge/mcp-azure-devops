const Joi = require("joi");

const schema = Joi.object({
  PORT: Joi.number().default(4000),
  AZURE_ORG: Joi.string().required(),
  AZURE_PROJECT: Joi.string().required(),
  AZURE_PAT: Joi.string().required()
}).unknown();

const { value, error } = schema.validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

module.exports = value;