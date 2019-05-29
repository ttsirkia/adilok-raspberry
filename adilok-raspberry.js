/**
 * ADILOK for Raspberry PI
 *
 * Receives train running messages from Traffic Management Finland
 * and controls shift registers attached to Raspberry PI based on
 * the given rules.
 *
 * !! DO NOT USE FOR SAFETY-CRITICAL PURPOSES !!
 *
 * Data: Traffic Management Finland, https://rata.digitraffic.fi,
 * data is licensed with CC BY 4.0
 *
 * (C) Teemu Sirkiä, 2019
 * This software is MIT licensed.
 *
 */

'use strict';

const sleep = require('sleep');
const Gpio = require('onoff').Gpio;
const chalk = require('chalk');
const mqtt = require('mqtt');
const fs = require('fs');
const readline = require('readline');

// ************************************************************************************************

const clk = new Gpio(2, 'out');
const data = new Gpio(3, 'out');
const strobe = new Gpio(4, 'out');
const recv = new Gpio(14, 'out');
const ack = new Gpio(15, 'out');
const err = new Gpio(18, 'out');

clk.writeSync(0);
data.writeSync(0);
strobe.writeSync(0);
recv.writeSync(0);
ack.writeSync(0);
err.writeSync(1);

// ************************************************************************************************

const bits = [];
const rules = {};
let bitCount = 8;
let initialPattern = '';
let lastMessageReceived = Date.now();
let useRouteset = true;

// ************************************************************************************************

/**
 * Sends the current bit pattern to the shift registers. The first
 * bit is the last bit to transmit and therefore, it will be the
 * bit 0 in the first shift register, too.
 */
const sendPattern = function() {
  let counter, bit;
  for (counter = bits.length; counter > 0; counter--) {
    bit = bits[counter - 1];
    if (bit) {
      data.writeSync(1);
    }
    clk.writeSync(1);
    sleep.usleep(1);
    clk.writeSync(0);
    data.writeSync(0);
  }
  strobe.writeSync(1);
  sleep.usleep(1);
  strobe.writeSync(0);
};

// Operations for the GPIO pins

const clearBit = function(bit) {
  bits[bit] = false;
};

const setBit = function(bit) {
  bits[bit] = true;
};

const toggleBit = function(bit) {
  bits[bit] = !bits[bit];
};

const pulseBit = function(bit) {
  setBit(bit);
  setTimeout(function() {
    clearBit(bit);
  }, 100);
};

const pulseInternal = function(bit) {
  bit.writeSync(1);
  setTimeout(function() {
    bit.writeSync(0);
  }, 100);
};

const setInternal = function(bit, status) {
  bit.writeSync(status);
};

// ************************************************************************************************

const displayInfo = function() {
  console.log(chalk.bold.white('ADILOK - Train running message receiver for Raspberry PI'));
  console.log('Data: Traffic Management Finland, https://rata.digitraffic.fi/ (CC BY 4.0)');
  console.log(chalk.red('Only for non-safety critical purposes!'));
  console.log();
  console.log(chalk.green('Starting...'));
};

const printTrainTrackingMessage = function(message) {
  console.log(message.timestamp);
  let output = chalk.bold.white(message.trainNumber) + ' ' + chalk.bold.yellow(message.station) + ' ' + chalk.bold.cyan(message.trackSection) + ' ';
  if (message.type === 'OCCUPY') {
    output += chalk.bold.red(message.type);
  } else {
    output += chalk.bold.green(message.type);
  }
  console.log(output);
  output = '  ';
  output += (message.previousStation || '') + ' -> ' + message.station + ' -> ' + (message.nextStation || '');
  if (message.previousTrackSection || message.nextTrackSection) {
    output += '\n  ' + (message.previousTrackSection || '') + ' -> ' + message.trackSection + ' -> ' + (message.nextTrackSection || '');
  }
  console.log(output);
};

const printRoutesetMessage = function(message) {
  console.log(message.messageTime);
  let output = chalk.bold.white(message.trainNumber) + ' ' + chalk.bold.cyan(message.routeType) + '\n';
  message.routesections.forEach(function(rs) {
    output += chalk.bold.yellow(rs.stationCode) + ' ' + chalk.bold.green(rs.sectionId) + '->';
  });
  console.log(output);
};

const checkTrainTrackingRules = function(message, rule) {
  // Additional rules to check

  if (['ROUTESET', 'ROUTESET_S', 'ROUTESET_C'].indexOf(rule.type) >= 0) {
    return false;
  }

  if (rule.from && message.previousStation !== rule.from) {
    return false;
  }

  if (rule.fromSection && message.previousTrackSection !== rule.to) {
    return false;
  }

  if (rule.to && message.nextStation !== rule.to) {
    return false;
  }

  if (rule.toSection && message.nextTrackSection !== rule.to) {
    return false;
  }

  if (rule.type && message.type !== rule.type) {
    return false;
  }

  return true;

};

const checkRoutesetRules = function(message, rule, prev, next) {

  if (['ROUTESET', 'ROUTESET_S', 'ROUTESET_C'].indexOf(rule.type) < 0) {
    return false;
  }

  if (rule.type === 'ROUTESET' && message.routeType !== 'T') {
    return false;
  }

  if (rule.type === 'ROUTESET_S' && message.routeType !== 'S') {
    return false;
  }

  if (rule.type === 'ROUTESET_C' && message.routeType !== 'C') {
    return false;
  }

  if (rule.from && (prev.length === 0 || (prev.length > 0 && prev[prev.length - 1].stationCode !== rule.from))) {
    return false;
  }

  if (rule.to && (next.length === 0 || (next.length > 0 && next[0].stationCode !== rule.to))) {
    return false;
  }

  if (rule.fromSection && (prev.length === 0 || (prev.length > 0 && prev[prev.length - 1].sectionId !== rule.fromSection))) {
    return false;
  }

  if (rule.toSection && (next.length === 0 || (next.length > 0 && next[0].sectionId !== rule.toSection))) {
    return false;
  }

  return true;

};

/**
 * Runs the given action if all the conditions match.
 * If an action was taken, the acknowledge LED will
 * will blink once.
 */
const takeAction = function(message, rule) {

  if (message.routeType) {
    printRoutesetMessage(message);
  } else {
    printTrainTrackingMessage(message);
  }

  // Check which action to take
  console.log('  Action: ' + chalk.white.bold(rule.action) + ', bit ' + chalk.white.bold(rule.bit));
  if (rule.action === 'AUTO') {
    // Action to set the bit if 'OCCUPY' or set a route, otherwise clear it
    if (['OCCUPY', 'T', 'S'].indexOf(message.type) >= 0) {
      setBit(rule.bit);
    } else {
      clearBit(rule.bit);
    }
  } else if (rule.action === 'AUTOINV') {
    // Same as AUTO but inverted output
    if (['OCCUPY', 'T', 'S'].indexOf(message.type) >= 0) {
      clearBit(rule.bit);
    } else {
      setBit(rule.bit);
    }
  } else if (rule.action === 'SET') {
    // Set bit to 1
    setBit(rule.bit);
  } else if (rule.action === 'CLEAR') {
    // Set bit to 0
    clearBit(rule.bit);
  } else if (rule.action === 'TOGGLE') {
    // The bit will change its state
    toggleBit(rule.bit);
  } else if (rule.action === 'PULSE') {
    // Give a short pulse (~100 ms)
    pulseBit(rule.bit);
  } else {
    console.log(chalk.red.bold('  Unknown action!'));
  }
  console.log('');
  pulseInternal(ack);

};

/**
 * Checks if the received message matches with the
 * predefined rules. Only the station code and the
 * track section code (if present) are compared here.
 */
const handleTrainTrackingMessage = function(message) {

  if (rules[message.station]) {
    rules[message.station].forEach(function(rule) {
      if (checkTrainTrackingRules(message, rule)) {
        takeAction(message, rule);
      }
    });
  }

  if (rules[message.station + '|' + message.trackSection]) {
    rules[message.station + '|' + message.trackSection].forEach(function(rule) {
      if (checkTrainTrackingRules(message, rule)) {
        takeAction(message, rule);
      }
    });
  }

};

/**
 * Checks if the received message matches with the
 * predefined rules. Only the station code and the
 * section code (if present) are compared here.
 * Each route section is processed separately.
 */
const handleRoutesetMessage = function(message) {

  message.routesections.forEach(function(section, i) {
    if (rules[section.stationCode]) {
      rules[section.stationCode].forEach(function(rule) {
        if (checkRoutesetRules(message, rule, message.routesections.slice(0, i), message.routesections.slice(i + 1, section.length))) {
          takeAction(message, rule);
        }
      });
    }

    if (rules[section.stationCode + '|' + section.sectionId]) {
      rules[section.stationCode + '|' + section.sectionId].forEach(function(rule) {
        if (checkRoutesetRules(message, rule, message.routesections.slice(0, i), message.routesections.slice(i + 1, section.length))) {
          takeAction(message, rule);
        }
      });
    }
  });


};

const messageReceiver = function(channel, message) {

  // Blink the received LED always when messages arrive
  pulseInternal(recv);

  // Switch off the error LED
  setInternal(err, 0);

  lastMessageReceived = Date.now();

  try {
    if (channel === 'train-tracking') {
      handleTrainTrackingMessage(JSON.parse(message.toString()));
    } else if (channel === 'routesets') {
      handleRoutesetMessage(JSON.parse(message.toString()));
    }
  } catch (e) {
    setInternal(err, 1);
    console.log(chalk.red.bold('Cannot process the received message!'));
  }

};

const readConfig = function() {

  let parameter = null;

  // The config file can be the last command line parameter
  if (process.argv.length >= 3 && process.argv[process.argv.length - 1] !== '--debug' && process.argv[process.argv.length - 1] !== '--livedebug') {
    parameter = process.argv[process.argv.length - 1];
  }

  const filename = parameter || 'config.json';
  let config = fs.readFileSync(filename, { encoding: 'utf-8' });
  config = JSON.parse(config);
  bitCount = config.bits || 0;
  initialPattern = config.initialPattern || '';

  let ruleCount = 0;

  config.rules.forEach(function(rule) {

    if (!rule.action || rule.bit === undefined) {
      console.log(chalk.red.bold('Incorrect rule in config!'));
      return;
    }

    if (rule.station && !rule.trackSection) {
      rules[rule.station] = rules[rule.station] || [];
      rules[rule.station].push(rule);
      ruleCount += 1;
    } else if (rule.station && rule.trackSection) {
      rules[rule.station + '|' + rule.trackSection] = rules[rule.station + '|' + rule.trackSection] || [];
      rules[rule.station + '|' + rule.trackSection].push(rule);
      ruleCount += 1;
    } else {
      console.log(chalk.red.bold('Incorrect rule in config!'));
    }
  });

  if (process.argv[2] !== '--debug') {
    console.log(chalk.green(ruleCount + ' rules in use.'));
  }

};

const initialize = function() {

  displayInfo();
  readConfig();

  // Set the initial state for all bits and store it to the shift registers
  for (let i = 0; i < bitCount; i++) {
    bits[i] = initialPattern[i] === '1' || false;
  }
  sendPattern();

  // Shift registers will be updated every ~100 ms
  setInterval(sendPattern, 100);

};

const debug = function() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Bit: '
  });

  const printBits = function() {
    let bitString = '';
    let numberString = '';
    for (let i = 0; i < bitCount; i++) {
      bitString += bits[i] ? chalk.bold.green('*') : chalk.bold.red('-');
      numberString += (i % 10);
    }
    console.log(bitString);
    console.log(numberString);
    console.log();
  };

  console.log();
  console.log(chalk.yellow('Debug mode'));
  console.log('Type bit number (0-' + (bits.length - 1) + ') to toggle the bit.');
  console.log('Press Ctrl+C to exit the program.');
  console.log();

  printBits();

  rl.prompt();

  rl.on('line', function(line) {

    if (/^\d+$/.test(line.trim())) {

      const bitNumber = +line.trim();

      if (bitNumber >= 0 && bitNumber < bits.length) {
        toggleBit(bitNumber);
      }

    } else {
      console.log('\nIncorrect input!\n');
    }

    printBits();
    rl.prompt();

  }).on('close', () => process.exit(0));

};

const main = function() {

  const socket = mqtt.connect('ws://rata-mqtt.digitraffic.fi:9001');

  socket.on('close', function() {
    setInternal(err, 1);
    console.log(new Date().toISOString() + ' ' + chalk.yellow.bold('Socket disconnected.'));
  });

  socket.on('reconnect', function() {
    setInternal(err, 1);
    console.log(new Date().toISOString() + ' ' + chalk.yellow.bold('Reconnecting...'));
  });

  socket.on('connect', function() {
    console.log(new Date().toISOString() + ' ' + chalk.green('Socket connected.'));
    if (useRouteset) {
      socket.subscribe('routesets/#');
    }
    socket.subscribe('train-tracking/#');
  });

  socket.on('message', (topic, message) => messageReceiver(topic.split('/')[0], message));

  // Warning if no messages have been received
  setInterval(function() {
    if (Date.now() - lastMessageReceived > 60 * 1000) {
      setInternal(err, 1);
      lastMessageReceived = Date.now();
      console.log(new Date().toISOString() + ' ' + chalk.yellow.bold('No socket messages.'));
    }
  }, 2000);

};

initialize();

if (process.argv[2] === '--debug') {
  debug();
} else if (process.argv[2] === '--livedebug') {
  main();
  debug();
} else {
  main();
}
