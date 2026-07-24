const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const boardEl = document.getElementById("board");
const statusEl = document.getElementById("status");
const resetBtn = document.getElementById("reset-btn");
const scoreXEl = document.getElementById("score-x");
const scoreOEl = document.getElementById("score-o");
const scoreDrawEl = document.getElementById("score-draw");
const cells = [...document.querySelectorAll(".cell")];

let board = Array(9).fill("");
let currentPlayer = "X";
let gameOver = false;
let scores = { X: 0, O: 0, draw: 0 };

function setStatus(message, player = null) {
  if (player === "X") {
    statusEl.innerHTML = `Rândul lui <span class="player-x">X</span>`;
    return;
  }

  if (player === "O") {
    statusEl.innerHTML = `Rândul lui <span class="player-o">0</span>`;
    return;
  }

  statusEl.textContent = message;
}

function getWinner() {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }

  if (board.every((cell) => cell !== "")) {
    return { winner: "draw", line: [] };
  }

  return null;
}

function highlightWin(line) {
  line.forEach((index) => {
    cells[index].classList.add("win");
  });
}

function handleWin(result) {
  gameOver = true;

  if (result.winner === "draw") {
    scores.draw += 1;
    setStatus("Egalitate!");
  } else {
    scores[result.winner] += 1;
    highlightWin(result.line);
    const label = result.winner === "X" ? "X" : "0";
    const className = result.winner === "X" ? "player-x" : "player-o";
    statusEl.innerHTML = `<span class="${className}">${label}</span> a câștigat!`;
  }

  scoreXEl.textContent = scores.X;
  scoreOEl.textContent = scores.O;
  scoreDrawEl.textContent = scores.draw;
  cells.forEach((cell) => {
    cell.disabled = true;
  });
}

function handleMove(index) {
  if (gameOver || board[index] !== "") {
    return;
  }

  board[index] = currentPlayer;
  const cell = cells[index];
  cell.textContent = currentPlayer === "X" ? "X" : "0";
  cell.classList.add(currentPlayer === "X" ? "x" : "o");
  cell.disabled = true;

  const result = getWinner();
  if (result) {
    handleWin(result);
    return;
  }

  currentPlayer = currentPlayer === "X" ? "O" : "X";
  setStatus("", currentPlayer);
}

function resetGame() {
  board = Array(9).fill("");
  currentPlayer = "X";
  gameOver = false;

  cells.forEach((cell) => {
    cell.textContent = "";
    cell.disabled = false;
    cell.className = "cell";
  });

  setStatus("", "X");
}

cells.forEach((cell) => {
  cell.addEventListener("click", () => {
    handleMove(Number(cell.dataset.index));
  });
});

resetBtn.addEventListener("click", resetGame);
setStatus("", "X");
