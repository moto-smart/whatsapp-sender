// sms360.js (módulo Node.js)
const axios = require('axios');

class Sms360Client {
  constructor() {
    this.config = {
      apiLogin: process.env.SMS360_API_LOGIN,
      apiKey: process.env.SMS360_API_KEY,
      baseUrl: process.env.SMS360_BASE_URL || 'https://dashboard.360nrs.com/api/rest/sms'
    };
  }

  // Configuración inicial (similar al block configure de Ruby)
  static configure(callback) {
    const configInstance = new Sms360Client();
    callback(configInstance.config);
    return configInstance;
  }

  // Método para enviar SMS
  async send(to, message, from) {
    const authHeader = this._generateAuthHeader();
    
    try {
      const response = await axios({
        method: 'POST',
        url: this.config.baseUrl,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Language': 'es',
          'Authorization': authHeader
        },
        data: {
          to: Array.isArray(to) ? to : [to],
          message: message,
          from: from
        },
        httpsAgent: new (require('https').Agent)({ 
          rejectUnauthorized: false // Equivalente a VERIFY_NONE en Ruby (no recomendado para producción)
        })
      });

      return {
        success: response.status === 200,
        data: response.data,
        error: null
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error.response ? error.response.data : error.message
      };
    }
  }

  // Genera el header de autenticación
  _generateAuthHeader() {
    const credentials = Buffer.from(
      `${this.config.apiLogin}:${this.config.apiKey}`
    ).toString('base64');
    
    return `Basic ${credentials}`;
  }
}

module.exports = Sms360Client;