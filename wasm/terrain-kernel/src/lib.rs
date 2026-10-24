//! Deterministic f32-storage/f64-arithmetic landscape kernel. Loop/heap/tie
//! order deliberately follows the TypeScript reference, without fast math.
use std::cell::RefCell;

#[link(wasm_import_module = "math")]
extern "C" {
    // JavaScript engines may round hypot/exp differently from Rust's libm.
    // Use the same engine operations as the reference, including all f64 bits.
    fn hypot(a: f64, b: f64) -> f64;
    fn exp(a: f64) -> f64;
}
const SQRT2: f64 = std::f64::consts::SQRT_2;

struct Drainage {
    hydro: Vec<f32>, flow: Vec<i32>, area: Vec<f64>, order: Vec<i32>,
    processed: usize, outlet: f64, fill: f64,
}
fn less(a: usize, b: usize, z: &[f32]) -> bool { z[a] < z[b] || z[a] == z[b] && a < b }
fn push(heap: &mut Vec<usize>, cell: usize, z: &[f32]) {
    let mut i = heap.len(); heap.push(cell);
    while i > 0 { let parent = (i - 1) >> 1; if !less(cell, heap[parent], z) { break; } heap[i] = heap[parent]; i = parent; }
    heap[i] = cell;
}
fn pop(heap: &mut Vec<usize>, z: &[f32]) -> usize {
    let first = heap[0]; let last = heap.pop().unwrap();
    if !heap.is_empty() {
        let mut i = 0;
        while i * 2 + 1 < heap.len() {
            let mut child = i * 2 + 1;
            if child + 1 < heap.len() && less(heap[child + 1], heap[child], z) { child += 1; }
            if !less(heap[child], last, z) { break; } heap[i] = heap[child]; i = child;
        }
        heap[i] = last;
    }
    first
}
fn route(raw: &[f32], columns: usize, rows: usize, cell: f64, ltd: bool) -> Drainage {
    let n = raw.len(); let mut hydro = raw.to_vec(); let mut visited = vec![false; n];
    let mut heap = Vec::with_capacity(n); let mut rank = vec![0_i32; n]; let mut parent = vec![-1_i32; n];
    for y in 0..rows { for x in 0..columns { if x == 0 || y == 0 || x + 1 == columns || y + 1 == rows {
        let i = y * columns + x; visited[i] = true; push(&mut heap, i, &hydro);
    } } }
    let mut popped = 0; let mut fill = 0.0;
    while !heap.is_empty() {
        let i = pop(&mut heap, &hydro); let x = i % columns; let y = i / columns; rank[i] = popped; popped += 1;
        for dy in -1_isize..=1 { for dx in -1_isize..=1 {
            if dx == 0 && dy == 0 { continue; }
            let nx = x as isize + dx; let ny = y as isize + dy;
            if nx < 0 || ny < 0 || nx >= columns as isize || ny >= rows as isize { continue; }
            let j = ny as usize * columns + nx as usize;
            if visited[j] { continue; } visited[j] = true; parent[j] = i as i32;
            if hydro[j] < hydro[i] { fill += (hydro[i] as f64 - hydro[j] as f64) * cell * cell; hydro[j] = hydro[i]; }
            push(&mut heap, j, &hydro);
        } }
    }
    let mut flow = vec![-1_i32; n]; let mut indegree = vec![0_u8; n];
    for i in 0..n {
        let x = i % columns; let y = i / columns; let mut best = -1; let mut best_slope = 0.0; let mut flat_rank = rank[i];
        for dy in -1_isize..=1 { for dx in -1_isize..=1 {
            if dx == 0 && dy == 0 { continue; }
            let nx = x as isize + dx; let ny = y as isize + dy;
            if nx < 0 || ny < 0 || nx >= columns as isize || ny >= rows as isize { continue; }
            let j = ny as usize * columns + nx as usize; let drop = hydro[i] as f64 - hydro[j] as f64;
            let slope = drop / if dx != 0 && dy != 0 { SQRT2 } else { 1.0 };
            if slope > best_slope + 1e-8 { best_slope = slope; best = j as i32; }
            else if best_slope < 1e-8 && drop.abs() < 1e-6 && rank[j] < flat_rank { flat_rank = rank[j]; best = j as i32; }
        } }
        if best < 0 && parent[i] >= 0 { best = parent[i]; } flow[i] = best;
        if best >= 0 { indegree[best as usize] += 1; }
    }
    let mut area = vec![cell * cell; n]; let mut order = vec![0_i32; n]; let mut outlet = 0.0;
    let processed;
    if ltd {
        least_transverse(&hydro, columns, rows, cell, &rank, &mut flow, &mut area, &mut order, &mut outlet);
        processed = n;
    } else {
        let mut head = 0; let mut tail = 0;
        for i in 0..n { if indegree[i] == 0 { order[tail] = i as i32; tail += 1; } }
        while head < tail {
            let i = order[head] as usize; head += 1; let next = flow[i];
            if next < 0 { outlet += area[i]; } else { let next = next as usize; area[next] += area[i]; indegree[next] -= 1; if indegree[next] == 0 { order[tail] = next as i32; tail += 1; } }
        }
        processed = tail;
    }
    Drainage { hydro, flow, area, order, processed, outlet, fill }
}
fn least_transverse(z: &[f32], columns: usize, rows: usize, cell: f64, rank: &[i32], flow: &mut [i32], area: &mut [f64], order: &mut [i32], outlet: &mut f64) {
    let n = z.len(); let mut inherited = vec![0.0; n]; let mut largest = vec![0.0; n];
    for i in 0..n { order[n - 1 - rank[i] as usize] = i as i32; }
    let facets: [[isize; 4]; 8] = [[1,0,1,1],[0,1,1,1],[0,1,-1,1],[-1,0,-1,1],[-1,0,-1,-1],[0,-1,-1,-1],[0,-1,1,-1],[1,0,1,-1]];
    for &id in order.iter() {
        let i = id as usize; let x = i % columns; let y = i / columns; let height = z[i] as f64;
        let mut best_slope = 0.0; let mut cardinal = -1; let mut diagonal = -1;
        let (mut ux, mut uy, mut cdx, mut cdy, mut ddx, mut ddy) = (0.0,0.0,0.0,0.0,0.0,0.0);
        for [cx,cy,dx,dy] in facets {
            if x as isize + cx < 0 || x as isize + cx >= columns as isize || y as isize + cy < 0 || y as isize + cy >= rows as isize || x as isize + dx < 0 || x as isize + dx >= columns as isize || y as isize + dy < 0 || y as isize + dy >= rows as isize { continue; }
            let a = (i as isize + cy * columns as isize + cx) as usize; let b = (i as isize + dy * columns as isize + dx) as usize;
            let s1 = height - z[a] as f64; let s2 = z[a] as f64 - z[b] as f64;
            let mut ca = a; let mut cb = b;
            let (slope,vx,vy) = if s2 <= 0.0 { cb = a; (s1,cx as f64,cy as f64) }
                else if s2 >= s1 { ca = b; ((height - z[b] as f64) / SQRT2,dx as f64 / SQRT2,dy as f64 / SQRT2) }
                else { let slope = unsafe { hypot(s1,s2) }; (slope,(s1 * cx as f64 + s2 * (dx - cx) as f64) / slope,(s1 * cy as f64 + s2 * (dy - cy) as f64) / slope) };
            if slope > best_slope + 1e-8 {
                best_slope = slope; cardinal = ca as i32; diagonal = cb as i32; ux = vx; uy = vy;
                cdx = if ca == a { cx } else { dx } as f64; cdy = if ca == a { cy } else { dy } as f64;
                ddx = if cb == b { dx } else { cx } as f64; ddy = if cb == b { dy } else { cy } as f64;
            }
        }
        let mut receiver = flow[i]; let mut residual = 0.0;
        let lower = |j: i32| j >= 0 && (z[j as usize] < z[i] || z[j as usize] == z[i] && rank[j as usize] < rank[i]);
        if best_slope > 1e-8 && lower(cardinal) && lower(diagonal) {
            let first = inherited[i] + (ux * cdy - uy * cdx) * cell; let second = inherited[i] + (ux * ddy - uy * ddx) * cell;
            if first.abs() <= second.abs() { receiver = cardinal; residual = first; } else { receiver = diagonal; residual = second; }
        }
        flow[i] = receiver;
        if receiver < 0 { *outlet += area[i]; } else {
            let receiver = receiver as usize; area[receiver] += area[i];
            if area[i] > largest[receiver] { largest[receiver] = area[i]; inherited[receiver] = residual; }
        }
    }
}

fn hillslope(z: &[f32], loose: &[f64], columns: usize, rows: usize, cell: f64, coefficient: f64, sea: f64) -> (Vec<f32>,Vec<f64>,f64,f64,f64) {
    let n = z.len(); let coefficient = coefficient.clamp(0.0,0.2); let mut outgoing = vec![0.0; n]; let mut incoming = vec![0.0; n];
    let mut face = |a: usize,b: usize| {
        let (from,to) = if z[a] > z[b] { (a,b) } else { (b,a) };
        if z[from] as f64 <= sea { return; }
        let transfer = coefficient * (z[from] as f64 - z[to] as f64); outgoing[from] += transfer; incoming[to] += transfer;
    };
    for y in 1..rows.saturating_sub(1) { for x in 1..columns.saturating_sub(1) { let i = y * columns + x;
        if x + 1 < columns - 1 { face(i,i+1); } if y + 1 < rows - 1 { face(i,i+columns); }
    } }
    let mut next = z.to_vec(); let mut layer = loose.to_vec(); let mut bedrock = 0.0; let mut transferred = 0.0; let mut net = 0.0;
    for i in 0..n {
        let removed = loose[i].min(outgoing[i]); layer[i] = loose[i] - removed + incoming[i];
        bedrock += (outgoing[i] - removed) * (cell * cell); transferred += outgoing[i] * (cell * cell);
        next[i] = (z[i] as f64 + incoming[i] - outgoing[i]) as f32; net += (next[i] as f64 - z[i] as f64) * (cell * cell);
    }
    (next,layer,bedrock,transferred,net)
}
fn sediment(z: &[f32], drain: &Drainage, source: &[f64], columns: usize, rows: usize, cell: f64, sea: f64) -> (Vec<f64>,[f64; 5]) {
    let n = z.len(); let area = cell * cell;
    let sorted = sediment_order(&drain.hydro,&drain.order);
    let mut load = source.to_vec(); let mut deposition = vec![0.0; n]; let mut water = vec![area; n]; let mut marine = vec![false; n]; let mut queue = Vec::with_capacity(n);
    for y in 0..rows { for x in 0..columns { if (x == 0 || y == 0 || x + 1 == columns || y + 1 == rows) && z[y * columns + x] as f64 <= sea { let i = y * columns + x; marine[i] = true; queue.push(i); } } }
    let mut head = 0;
    while head < queue.len() {
        let i = queue[head]; head += 1; let x = i % columns; let y = i / columns;
        for j in [if x > 0 { i as isize - 1 } else { -1 }, if x + 1 < columns { i as isize + 1 } else { -1 }, if y > 0 { i as isize - columns as isize } else { -1 }, if y + 1 < rows { i as isize + columns as isize } else { -1 }] {
            if j >= 0 && !marine[j as usize] && z[j as usize] as f64 <= sea { marine[j as usize] = true; queue.push(j as usize); }
        }
    }
    let (mut exported,mut deposited,mut marine_deposited,mut terrestrial,mut lake) = (0.0,0.0,0.0,0.0,0.0);
    let mut targets = [0_usize; 8]; let mut weights = [0.0; 8];
    for i in sorted {
        let x = i % columns; let y = i / columns; let volume = load[i];
        if x == 0 || y == 0 || x + 1 == columns || y + 1 == rows { exported += volume; continue; }
        let mut receivers = 0; let mut sum = 0.0;
        for dy in -1_isize..=1 { for dx in -1_isize..=1 {
            if dx == 0 && dy == 0 { continue; } let j = (i as isize + dy * columns as isize + dx) as usize;
            let gradient = (drain.hydro[i] as f64 - drain.hydro[j] as f64) / (cell * if dx != 0 && dy != 0 { SQRT2 } else { 1.0 });
            if gradient <= 1e-10 { continue; } targets[receivers] = j; weights[receivers] = gradient; receivers += 1; sum += gradient;
        } }
        if receivers == 0 && drain.flow[i] >= 0 { targets[0] = drain.flow[i] as usize; weights[0] = 1.0; sum = 1.0; receivers = 1; }
        if receivers == 0 { exported += volume; continue; }
        let depth = (drain.hydro[i] as f64 - z[i] as f64).max(0.0); let standing = marine[i] || depth > 0.01;
        let channel_width = cell.min((0.0048 * water[i].sqrt()).max(1.0)); let width = if standing { cell } else { channel_width };
        let discharge = 0.7 * water[i] / width; let fluvial_length = cell.max(0.018 * discharge * if standing { 0.075 } else { 1.0 });
        // Same uncalibrated marine washload closure as sediment-transport.ts;
        // keep multiplication/division order to retain JS f64 rounding.
        let length = if marine[i] { fluvial_length.max(0.05 * (sea - z[i] as f64).max(1.0) / 0.00004) } else { fluvial_length };
        let attenuation = 1.0 - unsafe { exp(-cell / length) };
        let accommodation = if !marine[i] && depth > 0.01 { depth } else { (cell * 0.025).max(if marine[i] { sea - z[i] as f64 + 0.15 } else { 0.0 }) };
        let settled = (volume * attenuation).min(accommodation * area); deposition[i] = settled / area; deposited += settled;
        if marine[i] { marine_deposited += settled; } else { terrestrial += settled; if depth > 0.01 { lake += settled; } }
        let transported = volume - settled;
        for r in 0..receivers { let j = targets[r]; let fraction = weights[r] / sum; load[j] += transported * fraction; water[j] += water[i] * fraction; }
    }
    (deposition,[deposited,exported,marine_deposited,terrestrial,lake])
}

fn sediment_order(hydro: &[f32], order: &[i32]) -> Vec<usize> {
    // D8-LTD is reverse Priority-Flood order: hydro is nonincreasing and equal
    // heights already have ascending input-order rank. This is EXACTLY the
    // reference comparator's result, without sorting the same cells again.
    let mut sorted: Vec<usize> = order.iter().map(|&id| id as usize).collect();
    if order.windows(2).any(|pair| hydro[pair[0] as usize] < hydro[pair[1] as usize]) {
        let mut rank = vec![0; order.len()];
        for (i,&id) in order.iter().enumerate() { rank[id as usize] = i; }
        sorted.sort_unstable_by(|&a,&b| hydro[b].partial_cmp(&hydro[a]).unwrap().then(rank[a].cmp(&rank[b])));
    }
    sorted
}

#[cfg(test)]
mod tests {
    use super::sediment_order;
    #[test] fn monotonic_ties_preserve_input_rank() {
        assert_eq!(sediment_order(&[3.0,4.0,3.0,1.0],&[1,2,0,3]),vec![1,2,0,3]);
    }
    #[test] fn nonmonotonic_order_uses_full_comparator() {
        assert_eq!(sediment_order(&[3.0,4.0,3.0,1.0],&[0,3,2,1]),vec![1,0,2,3]);
    }
}

struct Kernel {
    columns: usize, rows: usize, cell: f64, raw: Vec<f32>, uplift: Vec<f32>, erodibility: Vec<f32>, seas: Vec<f64>,
    terrain: Vec<f32>, alluvium: Vec<f64>, cumulative: Vec<f32>, drainage: Drainage, first_flow: Vec<i32>,
    stats: [f64; 40], rms: Vec<f64>, passes: usize, iteration: usize, dt: f64, diffusion: f64, flags: u32,
}
impl Kernel {
    fn new(columns: usize, rows: usize, cell: f64, passes: usize) -> Self {
        let n = columns * rows;
        Self { columns,rows,cell,raw: vec![0.0;n],uplift: vec![0.0;n],erodibility: vec![0.0;n],seas: vec![0.0;passes+1],terrain: vec![0.0;n],alluvium: vec![0.0;n],cumulative: vec![0.0;n],drainage: Drainage { hydro: vec![0.0;n],flow: vec![-1;n],area: vec![0.0;n],order: vec![0;n],processed: 0,outlet: 0.0,fill: 0.0 },first_flow: vec![-1;n],stats: [0.0;40],rms: vec![0.0;passes],passes,iteration:0,dt:250.0,diffusion:0.0,flags:0 }
    }
    fn start(&mut self,dt: f64,diffusivity: f64,flags: u32) {
        self.terrain.clone_from(&self.raw); self.alluvium.fill(0.0); self.cumulative.fill(0.0); self.stats.fill(0.0); self.iteration = 0;
        self.dt = dt; self.diffusion = (diffusivity * dt / (self.cell * self.cell)).min(0.2); self.flags = flags;
        self.drainage = route(&self.terrain,self.columns,self.rows,self.cell,true); self.first_flow.clone_from(&self.drainage.flow);
    }
    fn step(&mut self,until: usize) {
        while self.iteration < until.min(self.passes) {
            let sea = self.seas[self.iteration+1]; let mut next = self.terrain.clone(); let mut detached = vec![0.0;self.raw.len()];
            for order_index in (0..self.drainage.processed).rev() {
                let i = self.drainage.order[order_index] as usize; let x = i % self.columns; let y = i / self.columns; let downstream = self.drainage.flow[i];
                if x == 0 || y == 0 || x + 1 == self.columns || y + 1 == self.rows { continue; }
                let uplift = if self.flags & 1 != 0 { self.uplift[i] as f64 } else { 0.0 } * self.dt; let raised = self.terrain[i] as f64 + uplift;
                next[i] = raised as f32; self.stats[12] += uplift * (self.cell * self.cell);
                if self.terrain[i] as f64 <= sea || downstream < 0 { continue; } let downstream = downstream as usize;
                let horizontal = if i % self.columns == downstream % self.columns || i / self.columns == downstream / self.columns { self.cell } else { self.cell * SQRT2 };
                let receiver_lake = self.drainage.hydro[downstream] as f64 - self.terrain[downstream] as f64 > 0.01;
                let receiver = sea.max(next[downstream] as f64).max(if receiver_lake { self.drainage.hydro[downstream] as f64 } else { f64::NEG_INFINITY });
                let k = if self.flags & 2 != 0 { self.erodibility[i] as f64 } else { 2.5e-5 }; let coefficient = self.dt * k * self.drainage.area[i].sqrt() / horizontal;
                let submerged = self.drainage.hydro[i] as f64 - self.terrain[i] as f64 > 0.01;
                let eroded = if !submerged && raised > receiver { (raised + coefficient * receiver) / (1.0 + coefficient) } else { raised };
                let incision = raised - eroded; let reentrained = self.alluvium[i].min(incision); self.alluvium[i] -= reentrained;
                self.stats[3] += reentrained * (self.cell * self.cell); self.stats[0] += (incision - reentrained) * (self.cell * self.cell);
                if self.flags & 4 != 0 { detached[i] = incision * (self.cell * self.cell); } else { self.stats[2] += incision * (self.cell * self.cell); }
                next[i] = eroded as f32; self.cumulative[i] = (self.cumulative[i] as f64 + incision) as f32; self.stats[11] += incision * self.cell * self.cell;
            }
            let (mut relaxed,loose,bedrock,transferred,net) = hillslope(&next,&self.alluvium,self.columns,self.rows,self.cell,self.diffusion,sea);
            self.alluvium = loose; self.stats[13] += net; self.stats[0] += bedrock; self.stats[7] += bedrock; self.stats[8] += transferred;
            if self.flags & 4 != 0 {
                let routed = route(&relaxed,self.columns,self.rows,self.cell,true);
                let (deposition,stats) = sediment(&relaxed,&routed,&detached,self.columns,self.rows,self.cell,sea);
                for i in 0..relaxed.len() { relaxed[i] = (relaxed[i] as f64 + deposition[i]) as f32; self.alluvium[i] += deposition[i]; }
                self.stats[1] += stats[0]; self.stats[2] += stats[1]; self.stats[4] += stats[2]; self.stats[5] += stats[3]; self.stats[6] += stats[4];
            }
            let mut squares = 0.0; for (i,&z) in relaxed.iter().enumerate() { let change = z as f64 - self.terrain[i] as f64; squares += change * change; }
            self.rms[self.iteration] = (squares / self.raw.len() as f64).sqrt(); self.terrain = relaxed;
            self.drainage = route(&self.terrain,self.columns,self.rows,self.cell,true); self.iteration += 1;
        }
        self.update_stats();
    }
    fn update_stats(&mut self) {
        let (mut squares,mut absolute,mut changed,mut reorganized,mut incision,mut cumulative,mut raising) = (0.0,0.0,0.0,0.0,0.0_f64,0.0_f64,0.0_f64);
        let (mut initial_volume,mut final_volume,mut stored) = (0.0,0.0,0.0);
        for i in 0..self.raw.len() {
            let change = self.terrain[i] as f64 - self.raw[i] as f64; squares += change * change; absolute += change.abs();
            if change.abs() > 0.01 { changed += 1.0; } if self.first_flow[i] != self.drainage.flow[i] { reorganized += 1.0; }
            incision = incision.max(-change); raising = raising.max(change); cumulative = cumulative.max(self.cumulative[i] as f64);
            initial_volume += self.raw[i] as f64 * (self.cell * self.cell); final_volume += self.terrain[i] as f64 * (self.cell * self.cell); stored += self.alluvium[i] * (self.cell * self.cell);
        }
        self.stats[9] = stored; self.stats[10] = self.stats[0] - stored - self.stats[2];
        self.stats[14] = incision; self.stats[15] = cumulative; self.stats[16] = raising; self.stats[17] = (squares / self.raw.len() as f64).sqrt();
        self.stats[18] = absolute / self.raw.len() as f64; self.stats[19] = changed; self.stats[20] = if self.iteration > 0 { self.rms[self.iteration-1] } else { 0.0 }; self.stats[21] = reorganized / self.raw.len() as f64;
        self.stats[22] = initial_volume; self.stats[23] = final_volume; self.stats[24] = final_volume - initial_volume - self.stats[12] + self.stats[11] - self.stats[1] - self.stats[13];
        self.stats[25] = self.drainage.processed as f64; self.stats[26] = self.drainage.outlet; self.stats[27] = self.drainage.fill;
    }
    fn ptr(&mut self,slot: u32) -> usize { match slot {
        0 => self.raw.as_mut_ptr() as usize,1 => self.uplift.as_mut_ptr() as usize,2 => self.erodibility.as_mut_ptr() as usize,3 => self.seas.as_mut_ptr() as usize,
        4 => self.terrain.as_mut_ptr() as usize,5 => self.alluvium.as_mut_ptr() as usize,6 => self.drainage.hydro.as_mut_ptr() as usize,7 => self.drainage.flow.as_mut_ptr() as usize,
        8 => self.drainage.area.as_mut_ptr() as usize,9 => self.drainage.order.as_mut_ptr() as usize,10 => self.stats.as_mut_ptr() as usize,11 => self.rms.as_mut_ptr() as usize,_ => 0,
    } }
}
thread_local! { static STATE: RefCell<Option<Kernel>> = const { RefCell::new(None) }; }
#[no_mangle] pub extern "C" fn terrain_abi_version() -> u32 { 1 }
#[no_mangle] pub extern "C" fn terrain_grid(columns: u32,rows: u32,cell: f64,passes: u32) -> u32 {
    let n = columns as u64 * rows as u64;
    if n == 0 || n > 1_048_576 || columns > 1_048_576 || rows > 1_048_576 || passes > 4096 || !cell.is_finite() || cell <= 0.0 { return 0; }
    STATE.with(|state| *state.borrow_mut() = Some(Kernel::new(columns as usize,rows as usize,cell,passes as usize))); 1
}
#[no_mangle] pub extern "C" fn terrain_buffer(slot: u32) -> usize { STATE.with(|state| state.borrow_mut().as_mut().map(|s| s.ptr(slot)).unwrap_or(0)) }
#[no_mangle] pub extern "C" fn terrain_route(ltd: u32) -> u32 { STATE.with(|state| {
    let mut state = state.borrow_mut(); let Some(s) = state.as_mut() else { return 0; };
    s.drainage = route(&s.raw,s.columns,s.rows,s.cell,ltd != 0); s.stats[25] = s.drainage.processed as f64; s.stats[26] = s.drainage.outlet; s.stats[27] = s.drainage.fill; 1
}) }
#[no_mangle] pub extern "C" fn terrain_start(dt: f64,diffusivity: f64,flags: u32) -> u32 {
    if !dt.is_finite() || dt < 0.0 || !diffusivity.is_finite() || diffusivity < 0.0 || flags & !7 != 0 { return 0; }
    STATE.with(|state| { let mut state = state.borrow_mut(); let Some(s) = state.as_mut() else { return 0; }; s.start(dt,diffusivity,flags); 1 })
}
#[no_mangle] pub extern "C" fn terrain_step(until: u32) -> u32 { STATE.with(|state| { let mut state = state.borrow_mut(); let Some(s) = state.as_mut() else { return 0; }; s.step(until as usize); s.iteration as u32 }) }
#[no_mangle] pub extern "C" fn terrain_release() { STATE.with(|state| *state.borrow_mut() = None); }
