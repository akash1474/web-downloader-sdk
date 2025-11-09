import { DownloadManager } from "./lib/DownloadManager.js";

const manager = new DownloadManager();
const urls: { url: string; filename: string }[] = [
  {
    url: "http://localhost:3000/large.zip",
    filename: "large.zip",
  },
  {
    url: "http://localhost:3000/Sapphire - Ed Sheeran.mp3",
    filename: "Sapphire - Ed Sheeran.mp3",
  },
];

const startBtn = document.getElementById("start-job") as HTMLButtonElement;
const jobsDiv = document.getElementById("jobs") as HTMLDivElement;

startBtn.addEventListener("click", async () => {
  if (!urls.length) return alert("No URLs added!");

  const job = manager.createJob(
    urls.map((u) => u.url),
    urls.map((u) => u.filename),
  );

  job.on("start", () => console.log("Job started"));
  job.on("complete", () => console.log("Job complete"));

  job.tasks.forEach((task) => {
    // Create task UI
    const wrapper = document.createElement("div");
    wrapper.className = "p-4 bg-white rounded shadow";

    const name = document.createElement("p");
    name.textContent = `Downloading: ${task.url}`;
    name.className = "font-medium";

    const progress = document.createElement("div");
    progress.className = "w-full bg-gray-200 rounded h-2 mt-2 overflow-hidden";
    const bar = document.createElement("div");
    bar.className = "bg-blue-600 h-2 w-0 transition-all";
    progress.appendChild(bar);

    const controls = document.createElement("div");
    controls.className = "flex gap-3 mt-2";

    const pauseBtn = document.createElement("button");
    pauseBtn.textContent = "⏸ Pause";
    pauseBtn.className = "bg-yellow-500 text-white px-3 py-1 rounded";

    const resumeBtn = document.createElement("button");
    resumeBtn.textContent = "▶ Resume";
    resumeBtn.className = "bg-green-600 text-white px-3 py-1 rounded";

    controls.appendChild(pauseBtn);
    controls.appendChild(resumeBtn);

    wrapper.append(name, progress, controls);
    jobsDiv.appendChild(wrapper);

    task.on("progress", ({ loaded, total, percent }) => {
      console.log(`Progress ${percent.toFixed(2)}%`);
      bar.style.width = `${percent}%`;
    });
    task.on("pause", () => console.log("Task paused", task.url));
    task.on("resume", () => console.log("Task resumed", task.url));
    task.on("complete", () => {
      bar.classList.remove("bg-blue-600");
      bar.classList.add("bg-green-600");
      console.log("Task complete", task.url);
    });

    pauseBtn.addEventListener("click", () => task.pause());
    resumeBtn.addEventListener("click", () => task.resume());
  });

  job.start();
});
