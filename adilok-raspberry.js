/**
 * ADILOK for Raspberry PI
 *
 * Receives train running messages from Finnish Transport Agency
 * and controls shift registers attached to Raspberry PI based on
 * the given rules.
 *
 * !! DO NOT USE FOR SAFETY-CRITICAL PURPOSES !!
 *
 * Data: Finnish Transport Agency, https://rata.digitraffic.fi,
 * data is licensed with CC BY 4.0
 *
 * (C) Teemu Sirkiä, 2017
 * This software is MIT licensed.
 *
 */

var sleep = require('sleep');
var Gpio = require('onoff').Gpio;
var chalk = require('chalk');
var SockJS = require('sockjs-client');
var Stomp = require('stompjs');
var fs = require('fs');

// ************************************************************************************************

var clk = new Gpio(2, 'out');
var data = new Gpio(3, 'out');
var strobe = new Gpio(4, 'out');
var recv = new Gpio(14, 'out');
var ack = new Gpio(15, 'out');
var err = new Gpio(18, 'out');

clk.writeSync(0);
data.writeSync(0);
strobe.writeSync(0);
recv.writeSync(0);
ack.writeSync(0);
err.writeSync(1);

// ************************************************************************************************

var bitCount = 8;
var initialPattern = '';
var bits = [];
var lastMessageReceived = Date.now();
var rules = {};

// ************************************************************************************************

/**
 * Sends the current bit pattern to the shift registers. The first
 * bit is the last bit to transmit and therefore, it will be the
 * bit 0 in the first shift register, too.
 */
var sendPattern = function() {
  var counter, bit;
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

var clearBit = function(bit) {
  bits[bit] = false;
};

var setBit = function(bit) {
  bits[bit] = true;
};

var toggleBit = function(bit) {
  bits[bit] = !bits[bit];
};

var pulseBit = function(bit) {
  setBit(bit);
  setTimeout(function() {
    clearBit(bit);
  }, 100);
};

var pulseInternal = function(bit) {
  bit.writeSync(1);
  setTimeout(function() {
    bit.writeSync(0);
  }, 100);
};

var setInternal = function(bit, status) {
  bit.writeSync(status);
};

// ************************************************************************************************

var displayInfo = function() {
  console.log(chalk.bold.white('ADILOK - Train running message receiver for Raspberry PI'));
  console.log('Data: Finnish Transport Agency, https://rata.digitraffic.fi/ (CC BY 4.0)');
  console.log(chalk.red('Only for non-safety critical purposes!'));
  console.log();
  console.log(chalk.green('Starting...'));
};

var printMessage = function(message) {
  console.log(message.timestamp);
  var output = chalk.bold.white(message.trainNumber) + ' ' + chalk.bold.yellow(message.station) + ' ' + chalk.bold.cyan(message.trackSection) + ' ';
  if (message.type == 'OCCUPY') {
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

/**
 * Runs the given action if all the conditions match.
 * If an action was taken, the acknowledge LED will
 * will blink once.
 */
var takeAction = function(message, rule) {

  // Additional rules to check

  if (rule.from && message.previousStation !== rule.from) {
    return;
  }

  if (rule.fromSection && message.previousTrackSection !== rule.to) {
    return;
  }

  if (rule.to && message.nextStation !== rule.to) {
    return;
  }

  if (rule.toSection && message.nextTrackSection !== rule.to) {
    return;
  }

  if (rule.type && message.type !== rule.type) {
    return;
  }

  printMessage(message);

  // Check which action to take
  console.log('  Action: ' + chalk.white.bold(rule.action) + ', bit ' + chalk.white.bold(rule.bit));
  if (rule.action === 'AUTO') {
    // Action to set the bit if 'OCCUPY', otherwise clear it
    if (message.type === 'OCCUPY') {
      setBit(rule.bit);
    } else {
      clearBit(rule.bit);
    }
  } else if (rule.action === 'AUTOINV') {
    // Same as AUTO but inverted output
    if (message.type === 'OCCUPY') {
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
 * track section code (if present) is compared here.
 */
var handleMessage = function(message) {
  if (rules[message.station]) {
    rules[message.station].forEach(function(rule) {
      takeAction(message, rule);
    });
  }

  if (rules[message.station + '|' + message.trackSection]) {
    rules[message.station + '|' + message.trackSection].forEach(function(rule) {
      takeAction(message, rule);
    });
  }
};

var messageReceiver = function(messages) {
  var data = JSON.parse(messages.body);

  // Blink the received LED always when messages arrive
  pulseInternal(recv);

  // Switch off the error LED
  setInternal(err, 0);

  lastMessageReceived = Date.now();

  data.forEach(function(message) {
    handleMessage(message);
  });
};

var socketFunction = function(frame) {
  console.log(chalk.green('Socket connected.'));
  stompClient.subscribe('/train-tracking/', function(messages) {
    messageReceiver(messages);
  });
};

var readConfig = function() {

  var filename = process.argv[2] || 'config.json';
  var config = fs.readFileSync(filename, { encoding: 'utf-8' });
  config = JSON.parse(config);
  bitCount = config.bits || 0;
  initialPattern = config.initialPattern || '';

  var ruleCount = 0;

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

  console.log(chalk.green(ruleCount + ' rules in use.'));

};

var main = function() {

  displayInfo();
  readConfig();

  // Set the initial state for all bits and store it to the shift registers
  for (var i = 0; i < bitCount; i++) {
    bits[i] = initialPattern[i] === '1' || false;
  }
  sendPattern();

  // Shift registers will be updated every ~100 ms
  setInterval(sendPattern, 100);

  var socket = new SockJS('https://rata.digitraffic.fi/api/v1/websockets/');
  stompClient = Stomp.over(socket);
  stompClient.connect({}, socketFunction);

  // If the latest message has been received over a minute ago,
  // try to reconnect the socket
  setInterval(function() {
    if (Date.now() - lastMessageReceived > 60 * 1000) {
      setInternal(err, 1);
      lastMessageReceived = Date.now();
      console.log(chalk.yellow.bold('No socket messages. Reconnecting...'));
      socket = new SockJS('https://rata.digitraffic.fi/api/v1/websockets/');
      stompClient = Stomp.over(socket);
      stompClient.connect({}, socketFunction);
    }
  }, 2000);

};

main();