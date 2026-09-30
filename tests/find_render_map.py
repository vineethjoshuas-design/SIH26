with open('static/js/app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for idx, line in enumerate(lines):
    if 'renderMapViews(' in line and 'this.' not in line:
        print(f"renderMapViews declared at line {idx+1}")
        for j in range(idx, min(idx+30, len(lines))):
            print(f"{j+1}: {lines[j]}", end="")
        break
