'use strict';

const Homey = require('homey');

class ValetudoApp extends Homey.App {

  async onInit() {
    this.log('Valetudo app initialized');
  }

}

module.exports = ValetudoApp;
