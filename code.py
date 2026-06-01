import os
import tkinter as tk
from tkinter import ttk, messagebox

# ===== CONFIGURATION =====
OUTPUT_FILE = "combined_project_code.txt"

EXCLUDE_DIRS = {
    ".git", "__pycache__", "node_modules",
    ".venv", "venv", "env", "dist", "build"
}

MAX_FILE_SIZE = 1_000_000  # 1 MB
# =========================


def is_text_file(filepath):
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            f.read(1024)
        return True
    except Exception:
        return False


def list_directories(base_dir="."):
    return sorted([
        d for d in os.listdir(base_dir)
        if os.path.isdir(d) and d not in EXCLUDE_DIRS
    ])


def collect_extensions(root_dir):
    extensions = set()

    for root, dirs, files in os.walk(root_dir):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

        for file in files:
            path = os.path.join(root, file)

            if os.path.getsize(path) > MAX_FILE_SIZE:
                continue

            if not is_text_file(path):
                continue

            _, ext = os.path.splitext(file)
            if ext:
                extensions.add(ext.lower())

    return sorted(extensions)


def combine_files(root_dir, include_extensions):
    with open(OUTPUT_FILE, "w", encoding="utf-8") as out:
        for root, dirs, files in os.walk(root_dir):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

            for file in files:
                filepath = os.path.join(root, file)
                relative_path = os.path.relpath(filepath, root_dir)

                _, ext = os.path.splitext(file)
                if ext.lower() not in include_extensions:
                    continue

                if os.path.getsize(filepath) > MAX_FILE_SIZE:
                    continue

                if not is_text_file(filepath):
                    continue

                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()

                out.write("\n" + "=" * 80 + "\n")
                out.write(f"FILE: {relative_path}\n")
                out.write("=" * 80 + "\n\n")
                out.write(content)
                out.write("\n")

    messagebox.showinfo("Done", f"Combined file created:\n{OUTPUT_FILE}")


def main_ui():
    root = tk.Tk()
    root.title("Project Combiner")
    root.geometry("400x500")

    selected_dir = tk.StringVar()
    extension_vars = {}

    ttk.Label(root, text="Select Root Directory", font=("Arial", 11, "bold")).pack(pady=10)

    dirs = list_directories()
    if not dirs:
        messagebox.showerror("Error", "No directories found.")
        root.destroy()
        return

    dir_dropdown = ttk.Combobox(root, values=dirs, textvariable=selected_dir, state="readonly")
    dir_dropdown.pack(pady=5)

    ttk.Label(root, text="Select File Extensions", font=("Arial", 11, "bold")).pack(pady=10)

    frame = ttk.Frame(root)
    frame.pack(fill="both", expand=True)

    canvas = tk.Canvas(frame)
    scrollbar = ttk.Scrollbar(frame, orient="vertical", command=canvas.yview)
    scroll_frame = ttk.Frame(canvas)

    scroll_frame.bind(
        "<Configure>",
        lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
    )

    canvas.create_window((0, 0), window=scroll_frame, anchor="nw")
    canvas.configure(yscrollcommand=scrollbar.set)

    canvas.pack(side="left", fill="both", expand=True)
    scrollbar.pack(side="right", fill="y")

    def load_extensions(event=None):
        for widget in scroll_frame.winfo_children():
            widget.destroy()
        extension_vars.clear()

        folder = selected_dir.get()
        if not folder:
            return

        extensions = collect_extensions(folder)
        if not extensions:
            ttk.Label(scroll_frame, text="No text files found").pack(anchor="w")
            return

        for ext in extensions:
            var = tk.BooleanVar(value=True)
            extension_vars[ext] = var
            ttk.Checkbutton(scroll_frame, text=ext, variable=var).pack(anchor="w")

    dir_dropdown.bind("<<ComboboxSelected>>", load_extensions)

    def proceed():
        folder = selected_dir.get()
        if not folder:
            messagebox.showwarning("Missing", "Please select a directory.")
            return

        selected_exts = [e for e, v in extension_vars.items() if v.get()]
        if not selected_exts:
            messagebox.showwarning("Missing", "Select at least one extension.")
            return

        combine_files(folder, set(selected_exts))

    ttk.Button(root, text="Proceed", command=proceed).pack(pady=15)

    root.mainloop()


if __name__ == "__main__":
    main_ui()
